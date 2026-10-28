(function (global) {
  'use strict';
  const VERSION = '1.0.0';
  const PROTOCOL = 1;
  const SHA256 = '1c804b56193ef5042d78ba81bd360c94ffd6fe6833a4cb8d8d491b98060317b7';
  const URL = 'https://raw.githubusercontent.com/nadabgfccvd/extensao-arn/main/agent-kit/releases/arena-ultra-agent-1.0.0.pyz';
  function encode(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
    return btoa(raw);
  }
  function session(p) {
    const role = p.agentRole || {};
    const index = Number(role.agentIndex || Number(role.index || 0) + 1);
    const roomId = String(p.roomId || 'solo');
    const gh = p.githubConfig || {};
    let github = {};
    if (gh.enabled && gh.repo) {
      const spec = global.AU_COLLAB.resolveGitRepoSpec(gh.repo);
      if (spec && spec.isGithub) github = {
        repo: spec.fullName,
        baseBranch: gh.baseBranch || spec.branchFromUrl || 'main',
        branch: gh.explicitBranch || global.AU_COLLAB.computeAgentBranchName(roomId, role, gh),
        cap: gh.agentVaultCap || '',
        accessLevel: global.AU_COLLAB.resolveEffectiveAgentAccessLevel(role, gh)
      };
    }
    return {
      protocol: PROTOCOL, roomId, agentIndex: index, epoch: Number(p.bindingEpoch || 1),
      agentName: String(role.shortTitle || role.agentName || `Agente ${index}`).slice(0,160),
      roleTitle: String(role.roleTitle || 'Especialista').slice(0,160),
      profile: p.profile || 'hybrid',
      filebinId: p.filebinId || (p.tempFileConfig && p.tempFileConfig.filebinId) || '',
      roomHmacKey: p.roomHmacKey || '', minTimestampMs: Number(p.minTimestampMs || 0),
      timerMinutes: Math.min(480, Math.max(0, Number(p.sessionTimerMinutes === undefined ? 60 : p.sessionTimerMinutes))),
      harnessEnabled: p.harnessEnabled !== false, github,
      allowUploads: !gh.enabled && Boolean(p.tempFileConfig && p.tempFileConfig.enabled),
      projectPath: '/home/user/repo'
    };
  }
  function initial(p = {}) {
    const cfg = session(p);
    const descriptor = encode(cfg); // Contains room-scoped capability/HMAC, never a GitHub PAT.
    const command = `curl -fsSL --retry 2 --max-time 60 '${URL}' -o /tmp/arena-ultra-agent.pyz && printf '%s  %s\\n' '${SHA256}' /tmp/arena-ultra-agent.pyz | sha256sum -c - && python3 /tmp/arena-ultra-agent.pyz install --session-b64 '${descriptor}' && /tmp/au_agent guide start`;
    const repoSpec = p.githubConfig && p.githubConfig.enabled ? global.AU_COLLAB.resolveGitRepoSpec(p.githubConfig.repo) : null;
    const externalRepoNote = repoSpec && !repoSpec.isGithub ? `Repositório externo ${repoSpec.webUrl}: broker GitHub indisponível para este host. Não invente suporte da API GitHub.` : '';
    let text = [
      `🤝 [SALA TEMPCHAT #${cfg.roomId} • AGENT KIT ${VERSION} • @Agente${cfg.agentIndex}]`,
      `OBJETIVO DA EQUIPE:\n${p.basePrompt || p.baseObjective || ''}`,
      p.specificTask ? `SUA FRENTE: ${p.specificTask}` : '',
      (p.agentRole && p.agentRole.roleDesc) ? `SUA FRENTE: ${String(p.agentRole.roleDesc).slice(0,600)}` : '',
      `Papel: ${cfg.agentName} — ${cfg.roleTitle}. Perfil ${cfg.profile}; stopMode ${p.stopMode || 'smart_consensus'}. Time unido; reivindique arquivos no Quadro antes de editar.`,
      externalRepoNote,
      'Execute uma vez no primeiro bash (não execute se hash/download falhar; nunca use versão mutável sem validação):',
      '```bash', command, '```',
      'Depois use /tmp/au_agent tick entre incrementos; guide collaboration/modes/security sob demanda. Copie doctor + report na resposta final do turno para a extensão recebê-los. Não exponha o descritor da sessão em chat/repositório. PAT fica no broker.',
      'Respeite timer REAL, limites, cards humanos e PARAR. Use [TEMPCHAT]...[/TEMPCHAT] para falas curtas; líder só encerra após integração e gates.'
    ].filter(Boolean).join('\n');
    if (global.AU_CRED_BROKER && global.AU_CRED_BROKER.scrubSecrets)
      text = global.AU_CRED_BROKER.scrubSecrets(text, (p.githubConfig && p.githubConfig.token) || '');
    return text;
  }
  function observe(room, agent, raw) {
    for (const m of String(raw || '').matchAll(/\[AU_AGENT_READY\]([\s\S]{1,600}?)\[\/AU_AGENT_READY\]/g)) {
      try {
        const v = JSON.parse(m[1]);
        if (String(v.roomId) !== String(room.roomId) || v.slot !== `ag${Number(agent.index || 0) + 1}` ||
            Number(v.epoch) !== Number(agent.bindingEpoch || 1)) continue;
        agent.agentKit = { version: String(v.version || '').slice(0,20), protocol: Number(v.protocol),
          compatible: v.protocol === PROTOCOL && v.version === VERSION, observedAt: Date.now(), trust: 'agent_reported' };
      } catch (_) {}
    }
  }
  global.AU_AGENT_KIT = { VERSION, PROTOCOL, SHA256, URL, session, initial, observe };
})(typeof globalThis !== 'undefined' ? globalThis : window);
