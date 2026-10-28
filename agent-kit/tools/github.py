#!/usr/bin/env python3
import sys, os, json, time, random, base64, subprocess, urllib.request, urllib.error, urllib.parse
REPO = "nadabgfccvd/AU_KIT_REPO"
CLONE_URL = "https://github.com/nadabgfccvd/AU_KIT_REPO.git"
WIKI_URL = "https://github.com/nadabgfccvd/AU_KIT_REPO.wiki.git"
BASE_BR = "main"
MY_BR = "au/AU_KIT_ROOM/sintese-final"
VAULT_MODE = True
VAULT_BIN = "AU_KIT_BIN"
VAULT_CAP = "AU_KIT_CAP"
ACCESS_LEVEL = "push_and_pr"
AGENT_SLOT = "ag1"
WORKDIR = "/home/user/repo"
ASKPASS = "/tmp/au_git_askpass.sh"
def tok():
    if VAULT_MODE: return ""
    if os.path.exists(ASKPASS):
        try:
            t = subprocess.check_output([ASKPASS, "Password"], text=True).strip()
            if t and t != "none": return t
        except Exception: pass
    return ""
def vault_rpc(action, args=None, timeout_s=18):
    if not VAULT_BIN or not VAULT_CAP: return None
    rid = f"{int(time.time()*1000)}_{AGENT_SLOT}_{random.randint(1000,9999)}"
    req_fn = f"auvault_req_{rid}.json"; res_fn = f"auvault_res_{rid}.json"
    payload = json.dumps({"reqId": rid, "cap": VAULT_CAP, "slot": AGENT_SLOT, "repo": REPO, "action": action, "args": args or {}, "ts": int(time.time()*1000)}, ensure_ascii=False).encode("utf-8")
    try:
        rq = urllib.request.Request(f"https://filebin.net/{VAULT_BIN}/{req_fn}", data=payload, method="POST", headers={"User-Agent": "curl/8.5.0", "Content-Type": "application/json", "Accept": "application/json", "cid": "au-vault"})
        with urllib.request.urlopen(rq, timeout=12) as r: r.read()
    except Exception: return None
    waited = 0.0
    while waited < timeout_s:
        time.sleep(1.5); waited += 1.5
        try:
            gq = urllib.request.Request(f"https://filebin.net/{VAULT_BIN}/{res_fn}", headers={"User-Agent": "curl/8.5.0", "Accept": "application/json", "Cookie": "verified=2024-05-24"})
            with urllib.request.urlopen(gq, timeout=8) as gr: return json.loads(gr.read().decode("utf-8"))
        except Exception: pass
    return None
def collect_repo_files(max_files=85, max_bytes=2200000):
    import stat as _stat
    out = []; total = 0
    always_skip = {".git", "node_modules", "__pycache__", ".venv", "venv", ".arena"}
    root_skip = {"dist", "build", "target", ".next", "out", "coverage"}
    if not os.path.isdir(WORKDIR): return out
    for root, dirs, files in os.walk(WORKDIR):
        is_top = os.path.abspath(root) == os.path.abspath(WORKDIR)
        dirs[:] = [d for d in dirs if d not in always_skip and not (is_top and d in root_skip)]
        for fn in sorted(files):
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, WORKDIR).replace("\\", "/")
            try:
                lst = os.lstat(full)
                if _stat.S_ISLNK(lst.st_mode):
                    link_target = os.readlink(full).encode("utf-8")
                    out.append({"path": rel, "base64": base64.b64encode(link_target).decode("ascii"), "mode": "120000"})
                    continue
                sz = lst.st_size
                if sz > 380000 or total + sz > max_bytes or len(out) >= max_files: continue
                with open(full, "rb") as fh: raw = fh.read()
                fmode = "100755" if (lst.st_mode & 0o111) else "100644"
                out.append({"path": rel, "base64": base64.b64encode(raw).decode("ascii"), "mode": fmode})
                total += sz
            except Exception: pass
    return out
def api(ep, method="GET", body=None, use_auth=True):
    t = tok() if use_auth else ""
    if ep.startswith("http"): url = ep
    elif ep.startswith("/repos/"): url = "https://api.github.com" + ep
    elif not ep or ep == "/": url = f"https://api.github.com/repos/{REPO}"
    else: url = f"https://api.github.com/repos/{REPO}" + (ep if ep.startswith("/") else "/" + ep)
    h = {"User-Agent": "ArenaUltra-AgentCLI/3.4.0", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if t: h["Authorization"] = f"Bearer {t}"
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        if e.code == 401 and t and method == "GET" and use_auth:
            return api(ep, method=method, body=body, use_auth=False)
        msg = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API HTTP {e.code} ({ep}): {msg}")
def sh(cmd, cwd=WORKDIR, check=True):
    return subprocess.run(cmd, shell=True, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=check)
def real_base():
    try:
        if BASE_BR:
            try:
                api("/branches/" + urllib.parse.quote(BASE_BR, safe=""))
                return BASE_BR
            except Exception: pass
        info = api("")
        return info.get("default_branch") or BASE_BR or "main"
    except Exception:
        return BASE_BR or "main"
def check_write_rbac(need_pr=False):
    if ACCESS_LEVEL in ("revoked", "read_only"):
        sys.exit(f"🔒 [RBAC CENTRAL]: Seu nível de acesso neste repositório é '{ACCESS_LEVEL}' (somente leitura/revogado). Escrita bloqueada.")
    if need_pr and ACCESS_LEVEL == "push_branch":
        return "branch_only"
    return "full"
cmd = sys.argv[1] if len(sys.argv) > 1 else "overview"
if cmd in ("vault-status", "whoami", "help", "--help"):
    print(json.dumps({"repo": REPO, "mode": "vault_broker_zero_token" if VAULT_MODE else "direct_agent_git", "rbac": ACCESS_LEVEL, "baseBranch": BASE_BR, "agentBranch": MY_BR, "vaultBrokerReady": bool(VAULT_MODE and VAULT_BIN and VAULT_CAP)}, ensure_ascii=False))
    sys.exit(0)
if cmd in ("overview", "status"):
    try:
        info = api("")
    except Exception:
        vr = vault_rpc("overview") if VAULT_MODE else None
        if vr and vr.get("ok") and vr.get("data"):
            d = vr["data"]; info = d.get("repo") or {}
            print(f"🔐 [COFRE ZERO-TOKEN] REPO: {info.get('fullName')} | Default: {info.get('defaultBranch')} | Seu RBAC: {ACCESS_LEVEL}")
            print("🌿 Branches:", ", ".join(b.get("name","") for b in (d.get("branches") or [])) or "nenhuma")
            print("🔀 PRs Abertos:", ", ".join(f"#{p['number']} {p['title']}" for p in (d.get("pulls") or [])) or "nenhum")
            sys.exit(0)
        raise
    try: prs = api("/pulls?state=open&per_page=15")
    except Exception: prs = []
    try: issues = [i for i in api("/issues?state=open&per_page=15") if "pull_request" not in i]
    except Exception: issues = []
    try: runs = (api("/actions/runs?per_page=6") or {}).get("workflow_runs") or []
    except Exception: runs = []
    try: commits = api("/commits?per_page=5")
    except Exception: commits = []
    try: branches = api("/branches?per_page=25")
    except Exception: branches = []
    perms = info.get("permissions") or {}
    auth_badge = f"Cofre Zero-Token (RBAC={ACCESS_LEVEL})" if VAULT_MODE else str(bool(perms.get("push") or tok()))
    print(f"🐙 REPO: {info.get('full_name')} ({'PRIVADO' if info.get('private') else 'PÚBLICO'}) | Default: {info.get('default_branch')} | Acesso: {auth_badge}")
    print("🌿 Branches: " + (", ".join(b.get("name","") for b in branches) if isinstance(branches, list) and branches else "repositório vazio"))
    print(f"🔀 Pull Requests Abertos ({len(prs)}): " + (", ".join(f"#{p['number']} {p['title']} [{p['head']['ref']}->{p['base']['ref']}]" for p in prs) or "nenhum"))
    print(f"🐛 Issues Abertas ({len(issues)}): " + (", ".join(f"#{i['number']} {i['title']}" for i in issues) or "nenhuma"))
    print(f"⚙️ Actions ({len(runs)} recentes): " + (", ".join(f"run#{r['id']} {r.get('name')}:{r.get('status')}/{r.get('conclusion')}" for r in runs) or "nenhuma"))
    if isinstance(commits, list):
        for c in commits[:5]: print(f"  commit {c['sha'][:7]}: {c['commit']['message'].splitlines()[0]}")
elif cmd in ("code", "tree", "files"):
    sub = (sys.argv[2] if len(sys.argv) > 2 else "").strip("/")
    ep = f"/contents/{urllib.parse.quote(sub)}" if sub else "/contents"
    res = api(ep)
    if isinstance(res, list):
        for it in res: print(f"{it.get('type'):4s}  {it.get('path')} ({it.get('size',0)} B)")
    elif isinstance(res, dict) and res.get("content"):
        print(base64.b64decode(res["content"]).decode("utf-8", errors="replace"))
    else: print(json.dumps(res, indent=2, ensure_ascii=False))
elif cmd == "branches":
    try: brs = api("/branches?per_page=30")
    except Exception:
        vr = vault_rpc("branches") if VAULT_MODE else None
        brs = (vr or {}).get("data") or []
    for b in brs: print(f"branch {b.get('name')} ({((b.get('commit') or {}).get('sha') or b.get('sha') or '')[:7]})")
elif cmd in ("prs", "pulls"):
    st = sys.argv[2] if len(sys.argv) > 2 else "all"
    try: plist = api(f"/pulls?state={st}&per_page=25")
    except Exception:
        vr = vault_rpc("prs", {"state": st}) if VAULT_MODE else None
        plist = (vr or {}).get("data") or []
    for p in plist:
        hd = (p.get("head") or {}).get("ref") if isinstance(p.get("head"), dict) else p.get("head")
        bs = (p.get("base") or {}).get("ref") if isinstance(p.get("base"), dict) else p.get("base")
        url = p.get("html_url") or p.get("htmlUrl") or ""
        print(f"PR #{p['number']} [{p['state']}] {p['title']} ({hd} -> {bs}) {url}")
elif cmd == "pr":
    n = sys.argv[2]
    try:
        p = api(f"/pulls/{n}"); files = api(f"/pulls/{n}/files?per_page=50")
    except Exception:
        vr = vault_rpc("pr", {"number": int(n)}) if VAULT_MODE else None
        if not vr or not vr.get("ok"): raise
        p = vr["data"]["pr"]; files = vr["data"]["files"]
    print(f"PR #{p['number']} [{p['state']}] {p['title']}\n{p.get('body') or ''}")
    for f in files: print(f"  {f['status']}: {f['filename']} (+{f['additions']}/-{f['deletions']})")
elif cmd in ("pr-ship", "pr-create"):
    rbac_mode = check_write_rbac(need_pr=True)
    rb = real_base()
    a2 = (sys.argv[2] if len(sys.argv) > 2 else "").strip()
    if a2 and " " in a2:
        br = MY_BR; cmsg = a2; title = a2
        body = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else f"Pull Request criado automaticamente na branch `{br}` sem intervenção humana."
    else:
        br = a2 or MY_BR
        cmsg = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else f"feat({br}): entrega autônoma via Arena Ultra"
        title = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else cmsg
        body = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else f"Pull Request criado automaticamente na branch `{br}` sem intervenção humana."
    if not br or br == rb: br = f"au/pr-{int(time.time())}"
    if os.path.isfile(body): body = open(body, "r", encoding="utf-8").read()
    if VAULT_MODE:
        files_payload = collect_repo_files()
        act = "push_files" if rbac_mode == "branch_only" else "pr_ship"
        vr = vault_rpc(act, {"branch": br, "baseBranch": rb, "message": cmsg, "prTitle": title, "prBody": body, "files": files_payload}, timeout_s=22) if files_payload else None
        if vr and vr.get("ok"):
            d = vr.get("data") or {}; pr_obj = d.get("pullRequest") or {}
            if pr_obj.get("htmlUrl"):
                print(f"✅ [COFRE ZERO-TOKEN] PR #{pr_obj.get('number')} PUBLICADO SEM EXPOR CREDENCIAL: [GITHUB_PR_CRIADO] {pr_obj['htmlUrl']} [/GITHUB_PR_CRIADO]")
            else:
                print(f"✅ [COFRE ZERO-TOKEN] Branch `{d.get('branch', br)}` atualizada ({(d.get('commitSha') or '')[:7]}) sem expor credencial!")
            sys.exit(0)
        elif vr and not vr.get("ok"):
            sys.exit(f"🔒 [COFRE ZERO-TOKEN RECUSOU]: {vr.get('error')}")
        print(f"🔐 [COFRE ZERO-TOKEN • CAS EXPORT AGENDADO]: Alterações salvas em {WORKDIR} para a branch `{br}`.")
        print(f"[GITHUB_PUSH_PRONTO] {cmsg} [/GITHUB_PUSH_PRONTO]")
        sys.exit(0)
    if not tok(): sys.exit("ERRO: Token PAT não configurado em /tmp/au_git_askpass.sh (ou ative o modo Cofre Zero-Token).")
    sh(f"git checkout -B {json.dumps(br)}", check=False)
    sh("git add -A")
    st = sh("git status --porcelain", check=False).stdout.strip()
    if st: sh(f"git commit -m {json.dumps(cmsg)}")
    sh("git fetch origin", check=False)
    sh(f"git pull --rebase origin {json.dumps(br)}", check=False)
    p_res = sh(f"git push -u origin {json.dumps(br)}", check=False)
    if p_res.returncode != 0: sys.exit(f"ERRO git push: {p_res.stderr}")
    if rbac_mode == "branch_only":
        print(f"✅ Branch `{br}` enviada (RBAC 'push_branch': criação de PR reservada ao Líder Sintetizador).")
        sys.exit(0)
    owner = REPO.split("/")[0]
    q = urllib.parse.urlencode({"state": "open", "head": f"{owner}:{br}", "base": rb})
    ex = api(f"/pulls?{q}")
    if isinstance(ex, list) and len(ex) > 0:
        pr = api(f"/pulls/{ex[0]['number']}", method="PATCH", body={"title": title, "body": body})
        print(f"✅ PR #{pr['number']} ATUALIZADO: [GITHUB_PR_CRIADO] {pr['html_url']} [/GITHUB_PR_CRIADO]")
    else:
        pr = api("/pulls", method="POST", body={"title": title, "head": br, "base": rb, "body": body})
        print(f"✅ PR #{pr['number']} CRIADO DIRETO: [GITHUB_PR_CRIADO] {pr['html_url']} [/GITHUB_PR_CRIADO]")
elif cmd == "pr-merge":
    check_write_rbac(need_pr=True)
    n = sys.argv[2]; m = sys.argv[3] if len(sys.argv) > 3 else "squash"
    if VAULT_MODE:
        vr = vault_rpc("pr_merge", {"number": int(n), "mergeMethod": m})
        print("Merged via Cofre:" if (vr and vr.get("ok")) else f"Erro Cofre: {(vr or {}).get('error')}", (vr or {}).get("data"))
    else:
        r = api(f"/pulls/{n}/merge", method="PUT", body={"merge_method": m})
        print("Merged:", r)
elif cmd in ("pr-comment", "issue-comment"):
    check_write_rbac(need_pr=False)
    n = sys.argv[2]; txt = " ".join(sys.argv[3:])
    if VAULT_MODE:
        vr = vault_rpc("pr_comment", {"number": int(n), "body": txt})
        print("Commented via Cofre:", ((vr or {}).get("data") or {}).get("html_url") or vr)
    else:
        r = api(f"/issues/{n}/comments", method="POST", body={"body": txt})
        print("Commented:", r.get("html_url"))
elif cmd == "issues":
    st = sys.argv[2] if len(sys.argv) > 2 else "open"
    try: ilist = api(f"/issues?state={st}&per_page=30")
    except Exception:
        vr = vault_rpc("issues", {"state": st}) if VAULT_MODE else None
        ilist = (vr or {}).get("data") or []
    for i in ilist:
        if "pull_request" not in i: print(f"Issue #{i['number']} [{i['state']}] {i['title']} ({i['html_url']})")
elif cmd == "issue":
    n = sys.argv[2]
    try: i = api(f"/issues/{n}"); cs = api(f"/issues/{n}/comments")
    except Exception:
        vr = vault_rpc("issue", {"number": int(n)}) if VAULT_MODE else None
        if not vr or not vr.get("ok"): raise
        i = vr["data"]["issue"]; cs = vr["data"]["comments"]
    print(f"Issue #{i['number']} [{i['state']}] {i['title']}\n{i.get('body') or ''}")
    for c in cs: print(f"  @{c['user']['login']}: {c.get('body','')}")
elif cmd == "issue-new":
    check_write_rbac(need_pr=False)
    t_arg = sys.argv[2]; b_arg = sys.argv[3] if len(sys.argv) > 3 else ""
    if VAULT_MODE:
        vr = vault_rpc("issue_new", {"title": t_arg, "body": b_arg})
        print("Issue criada via Cofre:", ((vr or {}).get("data") or {}).get("html_url") or vr)
    else:
        r = api("/issues", method="POST", body={"title": t_arg, "body": b_arg})
        print("Issue criada:", r.get("html_url"))
elif cmd == "actions":
    try: runs = (api("/actions/runs?per_page=12") or {}).get("workflow_runs") or []
    except Exception:
        vr = vault_rpc("actions") if VAULT_MODE else None
        runs = (vr or {}).get("data") or []
    for r in runs: print(f"Run #{r['id']} | {r.get('name')} | branch={r.get('head_branch')} | {r.get('status')}/{r.get('conclusion')} | {r.get('html_url')}")
elif cmd in ("action-run", "action-jobs"):
    rid = sys.argv[2]
    try: jobs = (api(f"/actions/runs/{rid}/jobs") or {}).get("jobs") or []
    except Exception:
        vr = vault_rpc("action_run", {"runId": rid}) if VAULT_MODE else None
        jobs = (vr or {}).get("data") or []
    for j in jobs:
        print(f"Job {j['name']} -> {j.get('status')}/{j.get('conclusion')}")
        for s in (j.get("steps") or []):
            if s.get("conclusion") not in ("success", "skipped", None): print(f"  ❌ Step {s['number']}: {s['name']} ({s.get('conclusion')})")
elif cmd == "releases":
    for r in api("/releases?per_page=10"): print(f"Release {r.get('tag_name')}: {r.get('name')} ({r.get('html_url')})")
elif cmd == "projects":
    try: ms = api("/milestones?state=all")
    except Exception: ms = []
    vr = vault_rpc("projects") if VAULT_MODE else None
    if vr and vr.get("ok") and vr.get("data"):
        pdata = vr["data"]; plist = pdata.get("projects") or []
        print(f"Projects v2 GraphQL ({len(plist)}):", [f"#{p.get('number')} {p.get('title')} [{p.get('state')}] {p.get('url')}" for p in plist])
        if pdata.get("note"): print("Nota Projects v2:", pdata.get("note"))
    else:
        print("Projects v2 GraphQL: requer Cofre autenticado com escopo read:project.")
    print(f"Milestones ({len(ms)}):", [f"#{m['number']} {m['title']} ({m['open_issues']} abertas)" for m in ms] if isinstance(ms, list) else [])
elif cmd == "wiki":
    subprocess.run(["rm", "-rf", "/home/user/repo-wiki"])
    r = sh(f"git clone {json.dumps(WIKI_URL)} /home/user/repo-wiki", cwd="/home/user", check=False)
    print("Wiki clonada em /home/user/repo-wiki!" if r.returncode == 0 else f"Wiki vazia ou desativada no repo: {r.stderr.strip()}")
elif cmd in ("insights", "pulse"):
    try: contribs = api("/contributors?per_page=15")
    except Exception: contribs = []
    try: tags = api("/tags?per_page=15")
    except Exception: tags = []
    c_str = ", ".join(f"{c['login']}({c['contributions']})" for c in contribs) if isinstance(contribs, list) and contribs else "nenhum/calculando"
    t_str = ", ".join(t["name"] for t in tags) if isinstance(tags, list) and tags else "nenhuma"
    print("Contribuidores:", c_str)
    print("Tags:", t_str)
else:
    print(json.dumps(api(cmd), indent=2, ensure_ascii=False))
