(function (global) {
  'use strict';
  const VERSION = 1;
  const POLICIES = Object.freeze({
    fixed: 'Avance uma tarefa delimitada, valide e salve próximo passo; não recomece o projeto.',
    queue: 'Execute a etapa atual da fila; registre aceite antes de passar à seguinte.',
    conditional: 'Reproduza a falha, faça a menor correção e rode a regressão; não repita tentativas idênticas.',
    hybrid: 'Priorize bloqueio reproduzível, depois etapa da fila, depois melhoria validável.',
    specialists: 'Assuma arquivos no Quadro Único, congele contratos e implemente só sua frente. Revise um colega diferente.',
    parallel_leader: 'Divida por dependências; publique interfaces cedo e integre incrementos reais. Líder não refaz especialistas.',
    debate_consensus: 'Proponha alternativas com evidências, critique o contrato e registre decisão; discordância não exige versões concorrentes.'
  });
  const PYTHON_SOURCE = "#!/usr/bin/env python3\n\"\"\"Arena Ultra harness. Local evidence is observed here, not remotely attested.\"\"\"\nimport sys, os, json, time, hashlib, subprocess, tempfile, fcntl\nfrom pathlib import Path\n\ndef main():\n    scope = os.environ.get('AU_HARNESS_SCOPE', 'solo')\n    if not scope or len(scope) > 100 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in scope):\n        raise ValueError('Invalid scope')\n    root = Path(os.environ.get('AU_STATE_DIR', '/home/user/au_state')) / 'harness' / scope\n    root.mkdir(parents=True, exist_ok=True)\n    config_file = root / 'config.json'\n    if not config_file.exists():\n        raise ValueError('Install the scoped harness first')\n    cfg = json.loads(config_file.read_text())\n    state_file = root / 'checkpoint.json'\n    args = sys.argv[1:]; cmd = args.pop(0) if args else 'status'\n    # Serialize commands in this workspace. Never pretend this lock spans sandboxes.\n    with open(root / 'state.lock', 'a') as lock:\n        fcntl.flock(lock, fcntl.LOCK_EX)\n        st = json.loads(state_file.read_text()) if state_file.exists() else {\n            'revision': 1, 'tasks': {}, 'next': '', 'blocker': '', 'tests': [], 'reviews': []}\n        if cmd == 'bind':\n            epoch = int(args[0])\n            if epoch < 1 or epoch > 1000000000: raise ValueError('Invalid epoch')\n            if epoch != cfg['epoch']:\n                cfg['epoch'] = epoch\n                config_file.write_text(json.dumps(cfg))\n                st['revision'] += 1; st['tests'] = []; st['reviews'] = []\n                for item in st['tasks'].values(): item['status'] = 'pending'\n        elif cmd == 'task':\n            key, description = args[0], ' '.join(args[1:])\n            if not key or len(key) > 60: raise ValueError('Task id required, <=60 chars')\n            if key not in st['tasks'] and len(st['tasks']) >= 20: raise ValueError('Task limit reached')\n            st['tasks'][key] = {'description': description[:600], 'status': 'pending'}\n            st['revision'] += 1; st['tests'] = []\n        elif cmd == 'checkpoint':\n            st['next'] = ' '.join(args)[:600]\n            st['revision'] += 1; st['tests'] = []\n        elif cmd == 'blocker':\n            st['blocker'] = ' '.join(args)[:400]\n        elif cmd == 'verify':\n            # argv only: no shell interpolation; stdout goes to a temporary file, not prompts.\n            key = args.pop(0)\n            if args and args[0] == '--': args.pop(0)\n            if key not in st['tasks'] or not args: raise ValueError('verify TASK -- command args')\n            started = time.time()\n            with tempfile.TemporaryFile() as log:\n                try:\n                    result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=120, check=False)\n                    code = result.returncode\n                except subprocess.TimeoutExpired: code = 124\n                except OSError: code = 127\n                log.seek(0); digest = hashlib.sha256()\n                while True:\n                    data = log.read(65536)\n                    if not data: break\n                    digest.update(data)\n            evidence = {'task': key, 'exitCode': code, 'revision': st['revision'],\n                        'digest': digest.hexdigest(), 'at': int(time.time()*1000),\n                        'durationMs': int((time.time()-started)*1000)}\n            st['tests'] = [t for t in st['tests'] if t['task'] != key] + [evidence]\n            st['tests'] = st['tests'][-100:]\n            st['tasks'][key]['status'] = 'passed' if code == 0 else 'failed'\n            print('Verification exit code:', code, '| output SHA256:', evidence['digest'])\n        elif cmd == 'review':\n            target, revision, decision = args[:3]\n            if target == cfg['slot'] or decision not in ('accept', 'reject'):\n                raise ValueError('Independent reviewer required: review agN REV accept|reject')\n            st['reviews'] = [v for v in st['reviews'] if v['target'] != target] + [\n                {'target': target, 'revision': int(revision), 'decision': decision}]\n            st['reviews'] = st['reviews'][-60:]\n        elif cmd not in ('status', 'resume', 'report'):\n            raise ValueError('Commands: task, checkpoint, blocker, verify, review, status, resume, report')\n        st['updatedAt'] = int(time.time()*1000)\n        fd, temporary = tempfile.mkstemp(dir=root, prefix='checkpoint-')\n        with os.fdopen(fd, 'w') as f:\n            json.dump(st, f, ensure_ascii=False); f.flush(); os.fsync(f.fileno())\n        os.replace(temporary, state_file)\n        if cmd == 'report':\n            evidence = [t for t in st['tests'] if t['revision'] == st['revision']]\n            complete = bool(st['tasks']) and all(v['status'] == 'passed' for v in st['tasks'].values()) and len({t['task'] for t in evidence if t['exitCode'] == 0}) >= len(st['tasks'])\n            # Bound summaries; no tokens, command lines, stdout, or environment values in report.\n            report = {**cfg, 'revision': st['revision'], 'complete': complete,\n                      'evidence': evidence[-20:], 'reviews': st['reviews'][-60:],\n                      'blocker': bool(st['blocker']), 'taskCount': len(st['tasks'])}\n            print('[HARNESS_REPORT]' + json.dumps(report, separators=(',', ':')) + '[/HARNESS_REPORT]')\n        else:\n            print(json.dumps(st, ensure_ascii=False, indent=2))\n\nif __name__ == '__main__':\n    try: main()\n    except (ValueError, IndexError, KeyError, json.JSONDecodeError) as exc:\n        print('Harness error:', str(exc), file=sys.stderr); sys.exit(2)\n";
  function fresh() { return { version: VERSION, reports: {}, stalls: {}, events: [], gate: null }; }
  function cleanReports(raw, roomId, slot, epoch) {
    const reports = [];
    for (const match of String(raw || '').matchAll(/\[HARNESS_REPORT\]([\s\S]{1,16000}?)\[\/HARNESS_REPORT\]/g)) {
      try {
        const v = JSON.parse(match[1]);
        if (String(v.roomId) !== String(roomId) || v.slot !== slot || Number(v.epoch) !== Number(epoch) ||
            !Number.isSafeInteger(v.revision) || v.revision < 1 || v.revision > 1000000) continue;
        reports.push({ roomId: String(roomId), slot, epoch: Number(epoch), revision: v.revision,
          complete: v.complete === true, blocker: v.blocker === true,
          taskCount: Number.isSafeInteger(v.taskCount) ? Math.min(20, Math.max(0, v.taskCount)) : 0,
          evidence: (Array.isArray(v.evidence) ? v.evidence : []).slice(-20).filter(e =>
            e && typeof e.task === 'string' && e.task.length <= 60 && e.exitCode === 0 && e.revision === v.revision && /^[a-f0-9]{64}$/.test(e.digest || '')
          ).map(e => ({ task: e.task, revision: e.revision, digest: e.digest, exitCode: 0 })),
          reviews: (Array.isArray(v.reviews) ? v.reviews : []).slice(-60).filter(e =>
            e && /^ag[1-9]\d*$/.test(e.target) && e.target !== slot &&
            Number.isSafeInteger(e.revision) && ['accept','reject'].includes(e.decision)
          ).map(e => ({ target: e.target, revision: e.revision, decision: e.decision })),
          trust: 'agent_reported' });
      } catch (_) { /* Untrusted model text cannot mutate controller state. */ }
    }
    return reports;
  }
  function observe(room, agent, raw) {
    if (!room.harness) return;
    const slot = `ag${Number(agent.index || 0) + 1}`;
    const records = cleanReports(raw, room.roomId, slot, agent.bindingEpoch || 1);
    let changed = false;
    room.harness.stalls = room.harness.stalls || {};
    for (const v of records) {
      const old = room.harness.reports[slot];
      if (old && old.epoch === v.epoch && old.revision > v.revision) continue;
      if (JSON.stringify(old) === JSON.stringify(v)) continue;
      changed = true;
      room.harness.reports[slot] = v;
      room.harness.events.push({ at: Date.now(), slot, revision: v.revision, type: 'checkpoint_report' });
      room.harness.events = room.harness.events.slice(-100);
    }
    room.harness.stalls[slot] = changed ? 0 : Math.min(99, Number(room.harness.stalls[slot] || 0) + 1);
    room.harness.gate = gate(room);
  }
  function gate(room) {
    if (!room.harness) return { ok: true, reasons: [], legacy: true };
    const active = (room.agents || []).filter(a => !a.closed && a.screeningStatus !== 'refused_stopped');
    const reports = room.harness.reports || {};
    const reasons = [];
    for (const a of active) {
      const slot = `ag${Number(a.index || 0) + 1}`;
      const r = reports[slot];
      if (!r || r.epoch !== Number(a.bindingEpoch || 1) || !r.complete || r.blocker ||
          r.taskCount < 1 || new Set(r.evidence.map(e => e.task)).size < r.taskCount) {
        reasons.push(`${slot}: checkpoint/validação pendente`); continue;
      }
      if (active.length > 1) {
        const reviews = active.filter(b => b !== a).flatMap(b => {
          const peer = reports[`ag${Number(b.index || 0) + 1}`];
          return peer && peer.epoch === Number(b.bindingEpoch || 1) ? peer.reviews : [];
        }).filter(v => v.target === slot && v.revision === r.revision);
        if (!reviews.some(v => v.decision === 'accept') || reviews.some(v => v.decision === 'reject'))
          reasons.push(`${slot}: revisão independente rev ${r.revision} pendente/rejeitada`);
      }
    }
    if (!active.length) reasons.push('nenhum agente ativo');
    return { ok: reasons.length === 0, reasons, trust: 'agent_reported_not_attested' };
  }
  function hint(room) {
    if (!room.harness) return '';
    const g = gate(room);
    const stalled = Object.entries(room.harness.stalls || {}).filter(([,n]) => n >= 3).map(([slot]) => slot);
    const recovery = stalled.length ? ` Recuperação ${stalled.join(',')}: retome checkpoint, reproduza bloqueio e mude a abordagem; não repita loop sem evidência nova.` : '';
    const latest = Object.values(room.harness.reports || {}).map(r => `${r.slot}:r${r.revision}`).join(', ').slice(0,180);
    return (`Harness ${g.ok ? 'pronto para aceite existente' : g.reasons.slice(0,2).join('; ')}. ${latest}${recovery} Use /tmp/au_harness resume; valide e envie report. Revise outro agente por @nome.`).slice(0,480);
  }
  function bootstrap(opts = {}) {
    const roomId = String(opts.roomId || 'solo').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0,64);
    const slot = `ag${Math.max(1, Number(opts.agentIndex || 1))}`;
    const scope = `${roomId}_${slot}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0,100);
    const cfg = { roomId, slot, epoch: Number(opts.epoch || 1) };
    const policy = POLICIES[opts.mode] || POLICIES.hybrid;
    const wrapper = '#!/bin/sh\nexport AU_HARNESS_SCOPE=' + scope + '\nexec python3 /home/user/au_state/harness-cli.py "$@"';
    return [
      '\n🧰 HARNESS ARENA ULTRA — guia inicial (não repetir nas continuações)', policy,
      'Ciclo: retomar → escolher tarefa pequena → implementar → verificar → checkpoint → revisão. Estado local não substitui o Quadro Único.',
      'Instale no primeiro bash; não sobrescreva checkpoints existentes:',
      '```bash',
      `mkdir -p /home/user/au_state/harness/${scope}`,
      "cat << 'AU_HARNESS_PY' > /home/user/au_state/harness-cli.py", PYTHON_SOURCE, 'AU_HARNESS_PY',
      `printf '%s' '${JSON.stringify(cfg)}' > /home/user/au_state/harness/${scope}/config.json`,
      "cat << 'AU_HARNESS_SH' > /tmp/au_harness", wrapper, 'AU_HARNESS_SH',
      'chmod +x /tmp/au_harness && cp -f /tmp/au_harness /home/user/au_state/au_harness',
      `/tmp/au_harness resume`, '```',
      'Comandos: task ID "critério de aceite"; checkpoint "próximo passo" (invalida validações anteriores); verify ID -- comando args (executa realmente, timeout 120s, sem shell); blocker "motivo" ou blocker ""; review agN REV accept|reject; report.',
      'Cadastre todos os critérios reais, não testes triviais para enganar aceite. Depois das alterações, checkpoint e valide TODAS as tarefas. Grave próximo passo antes da última validação.',
      'Colaboração: envie a revisão e a revisão-alvo pelo chat: /tmp/au_chat send "@[Nome] revise meu checkpoint agN rev R". Revisor diferente executa testes/inspeciona entregas e registra review. Inclua a saída de report intacta no fim do turno; nunca forje evidências.',
      'Se /tmp for limpo: cp /home/user/au_state/au_harness /tmp/au_harness. O estado fica em /home/user/au_state/harness/<sala>_agN/checkpoint.json; não recomece do zero.',
      'A extensão verifica formato, sala, slot e epoch; resultados continuam declarados pelo agente, não são atestação remota. Não inclua segredos em tarefas/checkpoints. Segurança, limites, timer e PARAR prevalecem.'
    ].join('\n');
  }
  function continuation(mode) {
    return `🧰 Harness: ${POLICIES[mode] || POLICIES.hybrid} Retome /tmp/au_harness resume; valide, salve checkpoint e reporte. Sem repetir o guia.`;
  }
  global.AU_HARNESS = { VERSION, POLICIES, fresh, observe, gate, hint, bootstrap, continuation, cleanReports };
})(typeof globalThis !== 'undefined' ? globalThis : window);
