#!/usr/bin/env python3
"""Arena Ultra Agent Kit v1.0.0, protocol 1. Standard library only."""
import ast, base64, hashlib, json, os, re, shlex, subprocess, sys, tempfile, zipfile
from pathlib import Path
VERSION = '1.0.0'
PROTOCOL = 1
HOME = Path(os.environ.get('AU_AGENT_HOME', '/home/user')).resolve()
STATE = HOME / 'au_state'
ACTIVE = STATE / 'agent-session.json'
TOOL_NAMES = {'chat':'au_chat', 'timer':'au_timer', 'github':'au_gh', 'harness':'au_harness'}
SKIP = {'.git','node_modules','__pycache__','.venv','.next','dist','build','.cache','coverage'}

def atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def validate(raw):
    if not isinstance(raw,dict): raise ValueError('Session must be an object')
    if 'allowUploads' in raw and type(raw['allowUploads']) is not bool: raise ValueError('Invalid upload policy')
    if 'harnessEnabled' in raw and type(raw['harnessEnabled']) is not bool: raise ValueError('Invalid harness policy')
    cursor=raw.get('minTimestampMs',0)
    if type(cursor) is not int or not 0 <= cursor <= 1000000000000000: raise ValueError('Invalid chat cursor')
    for field in ('agentName','roleTitle'):
        if field in raw and (not isinstance(raw[field],str) or len(raw[field])>160): raise ValueError('Invalid identity label')
    if raw.get('protocol') != PROTOCOL: raise ValueError('Protocol mismatch: requires extension protocol 1')
    # Reject rather than save unexpected credential fields.
    allowed = {'protocol','roomId','agentIndex','agentName','roleTitle','epoch','filebinId','roomHmacKey',
               'minTimestampMs','timerMinutes','profile','github','projectPath','harnessEnabled','allowUploads'}
    if set(raw)-allowed: raise ValueError('Unknown session fields (credentials must remain in the extension)')
    rid = str(raw.get('roomId',''))
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',rid): raise ValueError('Invalid room identity')
    index, epoch = raw.get('agentIndex'), raw.get('epoch',1)
    if type(index) is not int or not 1 <= index <= 60: raise ValueError('Invalid agent index')
    if type(epoch) is not int or not 1 <= epoch <= 1000000000: raise ValueError('Invalid epoch')
    bin_id = str(raw.get('filebinId',''))
    if bin_id and not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',bin_id): raise ValueError('Invalid transport bucket')
    key = str(raw.get('roomHmacKey',''))
    if key and not re.fullmatch(r'[a-fA-F0-9]{64}',key): raise ValueError('Invalid room HMAC key')
    if bin_id and not key: raise ValueError('Signed room chat requires HMAC key')
    profile = raw.get('profile','hybrid')
    if profile not in ('fixed','queue','conditional','hybrid','specialists','parallel_leader','debate_consensus'):
        raise ValueError('Unknown profile')
    minutes = raw.get('timerMinutes',60)
    if type(minutes) is not int or not 0 <= minutes <= 480: raise ValueError('Invalid timer')
    gh = raw.get('github') or {}
    if not isinstance(gh,dict): raise ValueError('Invalid GitHub configuration')
    if re.search(r'(?:gh[pousr]_.*|github_pat_.*)',str(gh.get('cap',''))): raise ValueError('PAT must not be a scoped capability')
    if set(gh)-{'repo','baseBranch','branch','cap','accessLevel'}: raise ValueError('Unknown Git credential fields')
    if gh:
        if any(not isinstance(v,str) for v in gh.values()): raise ValueError('Invalid GitHub field type')
        if not re.fullmatch(r'[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+',gh.get('repo','')): raise ValueError('Invalid GitHub repository')
        if gh.get('accessLevel') not in ('push_and_pr','push_branch','read_only','revoked'): raise ValueError('Invalid RBAC')
        if len(str(gh.get('cap',''))) > 300: raise ValueError('Invalid scoped capability')
    project = Path(raw.get('projectPath') or HOME/'repo').resolve()
    if project == HOME or not project.is_relative_to(HOME): raise ValueError('Project must be a subdirectory of agent home')
    return {**raw, 'roomId':rid,'epoch':epoch,'profile':profile,'timerMinutes':minutes,
            'agentName':str(raw.get('agentName',f'Agente {index}'))[:160],
            'roleTitle':str(raw.get('roleTitle','Especialista'))[:160],
            'projectPath':str(project),'github':gh,'filebinId':bin_id,'roomHmacKey':key}

def patch(source, values):
    # Replace known top-level assignments only; repr is Python-safe, not string interpolation into code.
    tree=ast.parse(source); lines=source.splitlines(True)
    edits=[]
    for node in tree.body:
        if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name):
            name=node.targets[0].id
            if name in values: edits.append((node.lineno-1,node.end_lineno,f'{name} = {values[name]!r}\n'))
    for start,end,text in reversed(edits): lines[start:end]=[text]
    result=''.join(lines); compile(result,'configured-tool','exec'); return result

def unpack():
    source=Path(__file__).resolve()
    # In a zipapp __file__ is a virtual path; sys.argv[0] points to the real archive.
    archive=Path(sys.argv[0]).resolve()
    if not zipfile.is_zipfile(archive): return source.parent
    target=HOME/'au_agent'/VERSION
    with zipfile.ZipFile(archive) as z:
        manifest=json.loads(z.read('FILES.json'))
        for name,digest in manifest.items():
            rel=Path(name)
            if rel.is_absolute() or '..' in rel.parts or not re.fullmatch(r'[a-zA-Z0-9_./-]+',name): raise ValueError('Unsafe release path')
            data=z.read(name)
            if hashlib.sha256(data).hexdigest()!=digest: raise ValueError('Release file digest mismatch')
            dest=target/rel
            if not dest.resolve().is_relative_to(target.resolve()): raise ValueError('Unsafe symlink')
            atomic(dest,data.decode('utf-8'),0o700 if name.endswith('.py') else 0o600)
    return target

def install(root, session):
    cfg=validate(session); STATE.mkdir(parents=True,exist_ok=True)
    scope=f"{cfg['roomId']}_ag{cfg['agentIndex']}"
    tools=STATE/'agent-tools'/scope; tools.mkdir(parents=True,exist_ok=True)
    index=cfg['agentIndex']; gh=cfg['github']; repo=gh.get('repo','disabled/disabled')
    values={
        'chat':{'ROOM_ID':cfg['roomId'],'BIN_ID':cfg['filebinId'],'TAG':f'ag{index}',
                'MY_HANDLE':f'@Agente{index}','SENDER':cfg['agentName'],'ROLE':cfg['roleTitle'],
                'ROOM_HMAC_KEY':cfg['roomHmacKey'],'MIN_TS_CURSOR':int(cfg.get('minTimestampMs',0)),
                'SEEN':str(STATE/f"au_seen_{cfg['filebinId']}_ag{index}.json")},
        'timer':{'TAG':scope,'DEFAULT_MIN':cfg['timerMinutes']},
        'github':{'REPO':repo,'CLONE_URL':f'https://github.com/{repo}.git','WIKI_URL':f'https://github.com/{repo}.wiki.git',
                  'BASE_BR':gh.get('baseBranch','main'),'MY_BR':gh.get('branch','main'),'VAULT_MODE':True,
                  'VAULT_BIN':cfg['filebinId'],'VAULT_CAP':gh.get('cap',''),'ACCESS_LEVEL':gh.get('accessLevel','revoked'),
                  'AGENT_SLOT':f'ag{index}','WORKDIR':cfg['projectPath']}}
    for name in ('chat','timer','github','harness'):
        text=(root/'tools'/f'{name}.py').read_text()
        atomic(tools/f'{name}.py',patch(text,values.get(name,{})),0o700)
        wrapper=f'#!/bin/sh\nexport AU_STATE_DIR={shlex.quote(str(STATE))}\nexport AU_HARNESS_SCOPE={shlex.quote(scope)}\nexec python3 {shlex.quote(str(tools/f"{name}.py"))} "$@"\n'
        atomic(STATE/TOOL_NAMES[name],wrapper,0o700)
        atomic(Path('/tmp')/TOOL_NAMES[name],wrapper,0o700)
    # Existing harness remains source-compatible with the extension's gate.
    harness_config=STATE/'harness'/scope/'config.json'
    checkpoint=harness_config.parent/'checkpoint.json'
    if harness_config.exists() and checkpoint.exists() and json.loads(harness_config.read_text()).get('epoch') != cfg['epoch']:
        old=json.loads(checkpoint.read_text());old['revision']=int(old.get('revision',0))+1
        old['tests']=[];old['reviews']=[]
        for task in old.get('tasks',{}).values(): task['status']='pending'
        atomic(checkpoint,json.dumps(old))
    atomic(STATE/'harness'/scope/'config.json',json.dumps({'roomId':cfg['roomId'],'slot':f'ag{index}','epoch':cfg['epoch']}))
    for name in ('au_upload','au_download'):
        text=(root/'tools'/f'{name}.sh').read_text().replace('AU_KIT_BIN',cfg['filebinId'])
        if name == 'au_upload' and (cfg['github'] or not cfg.get('allowUploads',False)):
            text='#!/bin/sh\necho "Upload externo bloqueado pela política; use CAS/broker da extensão." >&2\nexit 3\n'
        atomic(STATE/name,text,0o700); atomic(Path('/tmp')/name,text,0o700)
    atomic(ACTIVE,json.dumps({**cfg,'kitRoot':str(root),'kitVersion':VERSION}))
    main=f'#!/bin/sh\nexport AU_AGENT_HOME={shlex.quote(str(HOME))}\nexec python3 {shlex.quote(str(root/"__main__.py"))} "$@"\n'
    atomic(STATE/'au_agent',main,0o700); atomic(Path('/tmp/au_agent'),main,0o700)
    print(f'Agent Kit {VERSION}; protocol {PROTOCOL}; sala {cfg["roomId"]}; @Agente{index}; instalado. Configuração sensível não exibida.')
    print('Próximo: /tmp/au_agent guide; /tmp/au_agent tick. Estado existente foi preservado.')

def load():
    if not ACTIVE.exists(): raise ValueError('Run install --session-b64 first')
    cfg=json.loads(ACTIVE.read_text()); return cfg

def invoke(name,args,cfg,capture=False):
    if name=='chat' and not cfg['filebinId']: raise ValueError('No shared chat transport in this solo session')
    if name=='github' and not cfg['github']: raise ValueError('No GitHub integration assigned')
    env={**os.environ,'AU_STATE_DIR':str(STATE),'AU_HARNESS_SCOPE':f"{cfg['roomId']}_ag{cfg['agentIndex']}"}
    script=STATE/'agent-tools'/f"{cfg['roomId']}_ag{cfg['agentIndex']}"/f'{name}.py'
    if capture:
        # Existing chat/timer output is small. Harness status is summarized separately.
        return subprocess.run(['python3',str(script),*args],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35).stdout
    return subprocess.call(['python3',str(script),*args],env=env)

def fingerprint(project):
    root=Path(project); digest=hashlib.sha256(); count=size=0
    if not root.exists(): raise ValueError('Project directory missing; create it before verify/report')
    for base,dirs,files in os.walk(root,followlinks=False):
        dirs[:]=sorted(d for d in dirs if d not in SKIP and not (Path(base)/d).is_symlink())
        for name in sorted(files):
            p=Path(base)/name
            if p.is_symlink(): continue
            count+=1; size+=p.stat().st_size
            if count>5000 or size>20000000: raise ValueError('Workspace fingerprint budget exceeded; narrow projectPath')
            digest.update(str(p.relative_to(root)).encode());digest.update(b'\0')
            with p.open('rb') as f:
                for chunk in iter(lambda:f.read(65536),b''): digest.update(chunk)
    return digest.hexdigest()

def main():
    args=sys.argv[1:];cmd=args.pop(0) if args else 'help'
    if cmd=='install':
        if len(args)!=2 or args[0]!='--session-b64' or len(args[1])>20000: raise ValueError('install --session-b64 BASE64_JSON')
        session=json.loads(base64.b64decode(args[1],validate=True))
        cfg=validate(session)  # Validate before extracting/writing any tools.
        install(unpack(),cfg);return 0
    if cmd=='help':
        print('au_agent guide [topic] | doctor | tick | inbox [offset|ack] | chat ... | timer ... | harness ... | verify TASK -- command args | report | github ...');return 0
    cfg=load(); root=Path(cfg['kitRoot']); scope=f"{cfg['roomId']}_ag{cfg['agentIndex']}"
    if cmd=='doctor':
        print('[AU_AGENT_READY]'+json.dumps({'version':VERSION,'protocol':PROTOCOL,'roomId':cfg['roomId'],'slot':f'ag{cfg["agentIndex"]}','epoch':cfg['epoch']})+'[/AU_AGENT_READY]')
        print(json.dumps({'kit':VERSION,'protocol':PROTOCOL,'roomId':cfg['roomId'],'slot':f'ag{cfg["agentIndex"]}',
                          'profile':cfg['profile'],'chatConfigured':bool(cfg['filebinId']),'githubConfigured':bool(cfg['github']),
                          'trust':'agent_reported_not_attested'}));return 0
    if cmd=='guide':
        topic=args[0] if args else 'start'
        if topic not in ('start','collaboration','modes','security','recovery'): raise ValueError('Unknown guide topic')
        print((root/'references'/f'{topic}.md').read_text());return 0
    inbox=STATE/'agent-inbox'/f'{scope}.json'
    if cmd=='inbox':
        if args and args[0]=='ack':
            atomic(inbox,json.dumps(''));print('Buffer acknowledged explicitly.');return 0
        offset=max(0,int(args[0])) if args else 0
        text=json.loads(inbox.read_text()) if inbox.exists() else ''
        print(text[offset:offset+2400])
        print(f'Inbox total={len(text)} chars; next offset={min(len(text),offset+2400)}. Use inbox ack only after reading all pages.')
        return 0
    if cmd=='tick':
        if cfg['filebinId']:
            buffered=json.loads(inbox.read_text()) if inbox.exists() else ''
            if len(buffered)<100000:
                chat=invoke('chat',['inbox'],cfg,True)
                if chat.strip():
                    atomic(inbox,json.dumps(buffered+'\n'+chat))
                    priority=[line for line in chat.splitlines() if '🎯' in line or '🔔' in line]
                    print(('\n'.join(priority) or chat)[:2400])
            else: print('Inbox buffer awaits reading/ack; transport not polled to avoid losing unread content.')
            print('Full chat preserved locally: /tmp/au_agent inbox 0; paginate before inbox ack.')
        if cfg['timerMinutes']>0: print(invoke('timer',['check'],cfg,True)[-700:])
        statefile=STATE/'harness'/scope/'checkpoint.json'
        state=json.loads(statefile.read_text()) if statefile.exists() else {}
        print(json.dumps({'revision':state.get('revision',1),'next':str(state.get('next',''))[:250],
                          'blocker':str(state.get('blocker',''))[:150],'tasks':len(state.get('tasks',{})),
                          'profile':cfg['profile']},ensure_ascii=False));return 0
    if cmd in ('verify','report'):
        marker=STATE/'harness'/scope/'workspace.json'; current=fingerprint(cfg['projectPath'])
        old=json.loads(marker.read_text()) if marker.exists() else {}
        if old.get('digest')!=current:
            invoke('harness',['checkpoint','Workspace alterado; revalidar tarefas antes do aceite'],cfg,True)
            atomic(marker,json.dumps({'digest':current}))
        code=invoke('harness',[cmd,*args],cfg)
        if cmd=='verify' and fingerprint(cfg['projectPath'])!=current:
            invoke('harness',['checkpoint','Verificação alterou arquivos; estabilizar workspace e revalidar'],cfg,True)
            print('Workspace changed during verification; previous evidence invalidated.',file=sys.stderr)
        return code
    if cmd in ('chat','timer','github','harness'):
        code=invoke(cmd,args,cfg)
        if code==0 and cmd=='harness' and args and args[0]=='bind':
            cfg['epoch']=int(args[1]);atomic(ACTIVE,json.dumps(cfg))
        return code
    raise ValueError('Unknown command; run help')

if __name__=='__main__':
    try: sys.exit(main() or 0)
    except (ValueError,KeyError,IndexError,OSError,subprocess.TimeoutExpired,json.JSONDecodeError,zipfile.BadZipFile):
        # No config values or credentials in error output.
        print('Agent Kit: operação recusada/falhou. Confira versão, sessão e guide recovery. Nenhuma credencial foi exibida.',file=sys.stderr);sys.exit(2)
