(function (global) {
  'use strict';

  function scrubIfPossible(text, token) {
    if (global.AU_INTEGRATIONS && typeof global.AU_INTEGRATIONS.scrubSecrets === 'function') {
      return global.AU_INTEGRATIONS.scrubSecrets(text, token);
    }
    return String(text || '')
      .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}\b/g, '[GITHUB_TOKEN_PROTEGIDO]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, '[GITHUB_TOKEN_PROTEGIDO]');
  }

  function generateFourDigitCode(existingCollection) {
    const hasCode = (code) => {
      if (!existingCollection) return false;
      if (existingCollection instanceof Set || existingCollection instanceof Map) {
        return existingCollection.has(code);
      }
      return Boolean(existingCollection[code]);
    };
    for (let attempt = 0; attempt < 150; attempt++) {
      const code = String(Math.floor(1000 + Math.random() * 9000));
      if (!hasCode(code)) return code;
    }
    return String(1000 + (Date.now() % 9000));
  }

  function slugifyRole(str) {
    return (
      String(str || 'agent')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 22) || 'agent'
    );
  }

  function computeAgentBranchName(roomId, agentRole, githubConfig) {
    const cfg = githubConfig || {};
    if (cfg.branchMode === 'single_shared_branch') {
      return (cfg.sharedBranch || `au/tempchat-${roomId}`).trim();
    }
    const idx = agentRole.agentIndex || Number(agentRole.index || 0) + 1;
    const isSynth = Boolean(agentRole.isSynthesizer || agentRole.isLeader);
    if (isSynth) {
      return `au/${roomId}/sintese-final`;
    }
    const slug = slugifyRole(agentRole.roleTitle || agentRole.shortTitle || `ag${idx}`);
    return `au/${roomId}/ag${idx}-${slug}`;
  }

  const SPECIALIST_TRACK_CATALOG = [
    {
      shortLabel: 'Core & Domínio',
      title: 'Engenheiro de Núcleo & Regras de Domínio',
      desc: 'Assume exclusivamente o motor central, modelos de domínio e regras de negócio acordadas com o time, sem tocar nos arquivos de UI ou infra de outros colegas.'
    },
    {
      shortLabel: 'Frontend & UX',
      title: 'Engenheiro de Interface, Componentes & UX',
      desc: 'Assume exclusivamente a camada visual, estados de interface, estilos e experiência do usuário, consumindo os contratos definidos com o Core/API.'
    },
    {
      shortLabel: 'Dados & Estado',
      title: 'Engenheiro de Persistência, Schemas & Estado',
      desc: 'Assume exclusivamente schemas, armazenamento, cache, migrações e integridade de dados, alinhando formatos com todo o time no TempChat.'
    },
    {
      shortLabel: 'APIs & Integrações',
      title: 'Engenheiro de APIs, Serviços & Conectores',
      desc: 'Assume exclusivamente endpoints, clientes de rede, serialização e integrações externas, publicando contratos claros para os colegas.'
    },
    {
      shortLabel: 'Segurança & Confiabilidade',
      title: 'Engenheiro de Segurança, Validação & Resiliência',
      desc: 'Assume exclusivamente autenticação, sanitização, limites, tratamento de falhas e proteção de borda em coordenação direta com o time.'
    },
    {
      shortLabel: 'Automação & Tooling',
      title: 'Engenheiro de Automação, Scripts & Pipeline',
      desc: 'Assume exclusivamente scripts utilitários, configuração, empacotamento, testes automatizados de suporte e DX da equipe.'
    }
  ];

  function makeRole(zeroIdx, shortTitle, roleTitle, roleDesc, isSynthesizer, exclusiveScopeHint = '') {
    const num = zeroIdx + 1;
    return {
      index: zeroIdx,
      agentIndex: num,
      slotKey: `ag${num}`,
      mentionHandle: `@Agente${num}`,
      shortTitle,
      agentName: shortTitle,
      roleTitle,
      roleDesc,
      roleBrief: roleDesc,
      exclusiveScopeHint: exclusiveScopeHint || roleDesc,
      isSynthesizer: Boolean(isSynthesizer),
      isLeader: Boolean(isSynthesizer)
    };
  }

  function buildTeamRoles(count, profile) {
    const total = Math.max(1, Number(count) || 2);
    const mode = profile || 'specialists';
    const roles = [];

    if (total === 1) {
      roles.push(
        makeRole(
          0,
          'Agente 1 • Líder Especialista',
          'Líder Especialista & Sintetizador',
          'Executa a solução completa, responde às orientações do TempChat e consolida a entrega final.',
          true,
          'Escopo integral (agente único na sala).'
        )
      );
      return roles;
    }

    if (mode === 'parallel_leader') {
      const workers = total - 1;
      for (let i = 0; i < workers; i++) {
        const track = SPECIALIST_TRACK_CATALOG[i % SPECIALIST_TRACK_CATALOG.length];
        const partitionTag = workers > SPECIALIST_TRACK_CATALOG.length ? ` #${i + 1}` : '';
        roles.push(
          makeRole(
            i,
            `Agente ${i + 1} • Frente ${i + 1}/${workers} (${track.shortLabel}${partitionTag})`,
            `Especialista da Frente ${i + 1}/${workers} — ${track.title}`,
            `Trabalha EM TIME UNIDO na Frente Exclusiva ${i + 1}/${workers} (${track.shortLabel}${partitionTag}): combina fronteiras de arquivos no TempChat antes de codar, NUNCA refaz o projeto inteiro sozinho e entrega sua parte pronta para encaixe com os outros ${total - 1} colegas.`,
            false,
            `Frente exclusiva ${i + 1}/${workers}: ${track.shortLabel}${partitionTag}`
          )
        );
      }
      roles.push(
        makeRole(
          total - 1,
          `Agente ${total} • Coordenador & Integrador`,
          'Coordenador de Fronteiras & Líder Integrador',
          `Facilita a divisão sem conflito entre as ${workers} frentes no TempChat, destrava dúvidas entre colegas (@Agente1..@Agente${workers}) e integra todas as contribuições reais em UMA única entrega unificada.`,
          true,
          `Coordenação das ${workers} frentes, colagem de interfaces e integração final unificada.`
        )
      );
      return roles;
    }

    if (mode === 'debate_consensus') {
      for (let i = 0; i < total; i++) {
        const isLast = i === total - 1;
        const track = SPECIALIST_TRACK_CATALOG[i % SPECIALIST_TRACK_CATALOG.length];
        roles.push(
          makeRole(
            i,
            isLast ? `Agente ${i + 1} • Mediador & Sintetizador` : `Agente ${i + 1} • Especialista (${track.shortLabel})`,
            isLast
              ? 'Mediador de Debate, Arquitetura & Síntese Unificada'
              : `Especialista Debatedor #${i + 1} — Foco em ${track.shortLabel}`,
            isLast
              ? 'Conduz o debate construtivo da equipe no TempChat, resolve divergências técnicas com perguntas diretas aos colegas, garante divisão limpa de responsabilidades sem competição e consolida a solução única do time.'
              : `Debate ativamente com os colegas no TempChat (nunca como competidor isolado!), lidera a análise e implementação da perspectiva "${track.shortLabel}", responde às perguntas de @colegas e constrói junto uma única solução consensual.`,
            isLast,
            isLast ? 'Mediação técnica, convergência de decisões e integração final.' : `Perspectiva e módulos de ${track.shortLabel}.`
          )
        );
      }
      return roles;
    }

    // Default: 'specialists' — scales cleanly for ANY N (2, 3, 4, 5, 8, 12, 20+ agents!)
    if (total === 2) {
      roles.push(
        makeRole(
          0,
          'Agente 1 • Arquiteto & Core',
          'Arquiteto de Contratos & Engenheiro Core/Backend',
          'Conversa com @Agente2 logo na abertura para dividir os arquivos sem sobreposição, define os contratos compartilhados e implementa a metade Core/ Domínio/ Dados.',
          false,
          'Arquitetura compartilhada + módulos Core/Backend/Dados (sem duplicar UI/QA do Agente 2).'
        )
      );
      roles.push(
        makeRole(
          1,
          'Agente 2 • Interface, QA & Integrador',
          'Engenheiro de Interface/Fluxos, QA & Líder Integrador',
          'Alinha contratos e divisão de arquivos com @Agente1 no TempChat, implementa a metade complementar (Interface/CLI/Fluxos + Testes QA) e une o trabalho dos dois em uma entrega única.',
          true,
          'Camada complementar (UI/Fluxos/Testes) + revisão cruzada e integração final unificada.'
        )
      );
      return roles;
    }

    if (total === 3) {
      roles.push(
        makeRole(
          0,
          'Agente 1 • Arquiteto & Core',
          'Arquiteto de Sistema, Contratos & Motor Core',
          'Propõe no TempChat a divisão exata de arquivos entre os 3 colegas, publica contratos únicos e implementa apenas os módulos de fundação/core acordados.',
          false,
          'Contratos compartilhados + fundação/motor Core.'
        )
      );
      roles.push(
        makeRole(
          1,
          'Agente 2 • Features & Interface',
          'Engenheiro de Funcionalidades, UI & Integrações',
          'Debate e valida os contratos com @Agente1 e @Agente3 no TempChat, reivindica seus arquivos exclusivos de funcionalidades/UI/rotas e constrói sem duplicar o Core.',
          false,
          'Funcionalidades de produto, interface/rotas e fluxos de usuário.'
        )
      );
      roles.push(
        makeRole(
          2,
          'Agente 3 • QA & Líder Integrador',
          'Especialista em Testes/Segurança & Líder Integrador',
          'Participa da divisão inicial no TempChat, cria suíte de testes/validação cobrindo os contratos de @Agente1 e @Agente2, revisa pendências com eles e consolida a entrega única do trio.',
          true,
          'Testes automatizados, casos de borda, segurança e integração final das 3 frentes.'
        )
      );
      return roles;
    }

    // total >= 4 (4, 5, 6, 8, 12, 20+ agents — dynamically partitioned!)
    const implCount = total - 3;
    roles.push(
      makeRole(
        0,
        'Agente 1 • Arquiteto Coordenador',
        'Coordenador de Arquitetura, Fronteiras & Contratos',
        `Lidera a roda inicial de alinhamento com todos os ${total} agentes no TempChat: propõe o mapa de diretórios/arquivos sem colisão para cada colega, publica contratos no Quadro Único e implementa a base estrutural compartilhada.`,
        false,
        `Mapa arquitetural das ${total} frentes, contratos compartilhados e bootstrap base.`
      )
    );
    for (let k = 1; k <= implCount; k++) {
      const zeroIdx = k;
      const track = SPECIALIST_TRACK_CATALOG[(k - 1) % SPECIALIST_TRACK_CATALOG.length];
      const subIdx = implCount > SPECIALIST_TRACK_CATALOG.length ? ` • Subfrente ${k}/${implCount}` : '';
      roles.push(
        makeRole(
          zeroIdx,
          `Agente ${zeroIdx + 1} • ${track.shortLabel} (${k}/${implCount})`,
          `${track.title}${subIdx}`,
          `${track.desc} Negocia fronteiras exatas com @Agente1 e seus pares no TempChat e constrói SOMENTE sua fatia (${k}/${implCount}) como parte de um único time coeso.`,
          false,
          `Fatia exclusiva ${k}/${implCount}: ${track.shortLabel}${subIdx}`
        )
      );
    }
    roles.push(
      makeRole(
        total - 2,
        `Agente ${total - 1} • QA & Contratos`,
        'Auditor de Qualidade, Testes Cruzados & Segurança',
        `Dialoga diretamente com @Agente1..@Agente${total - 2} e @Agente${total} no TempChat, verifica compatibilidade entre os módulos de todos os colegas, escreve testes integrados e aponta ajustes objetivos sem reescrever o escopo alheio.`,
        false,
        'Testes integrados entre módulos, auditoria de contratos/segurança e validação.'
      )
    );
    roles.push(
      makeRole(
        total - 1,
        `Agente ${total} • Líder Integrador`,
        'Líder de Convergência & Integrador da Entrega Unificada',
        `Garante que todos os ${total} membros atuem como um único time unido (zero trabalho duplicado!), coordena dependências no TempChat e integra todas as ${total - 1} frentes reais na solução final consolidada.`,
        true,
        `Orquestração de dependências e fusão final unificada das ${total} partes do time.`
      )
    );
    return roles;
  }

  function buildStopRuleInstruction(stopMode, isSynthesizer) {
    if (stopMode === 'endless_tokens') {
      return (
        'MODO DE REFINAMENTO CONTÍNUO ATÉ ESGOTAR TOKENS: Nunca encerre prematuramente nem trabalhe isolado. ' +
        'A cada rodada, dialogue diretamente com seus @colegas no TempChat, divida novas melhorias sem sobrepor arquivos e evolua o projeto em conjunto.'
      );
    }
    if (isSynthesizer) {
      return (
        'MODO DE PARADA INTELIGENTE (VOCÊ É O LÍDER INTEGRADOR): Na Rodada 1, NUNCA encerre nem tente fazer o projeto todo sozinho — alinhe a divisão de papéis/arquivos com seus colegas no TempChat! ' +
        'Somente a partir da Rodada 2+, depois que os colegas entregarem suas partes e você integrar o trabalho REAL de toda a equipe sem conflitos nem pendências, inicie uma nova linha com [ENTREGA_FINAL_PRONTA] seguido da entrega unificada.'
      );
    }
    return (
      'MODO DE PARADA INTELIGENTE (MEMBRO DE TIME UNIDO): Trabalhe estritamente no seu papel/arquivos combinados com a equipe, responda às dúvidas dos @colegas no bloco [TEMPCHAT]...[/TEMPCHAT] e, quando sua frente estiver testada e integrada aos contratos, execute `/tmp/au_chat ready`.'
    );
  }

  // =========================================================================
  // v3.4.0 — SHARED SINGLE-UPDATE BOARD, DEDUP, RBAC & INTEGRATION SLA ENGINE
  // =========================================================================

  function computeMessageFingerprint(senderName, text) {
    const cleanSender = String(senderName || '')
      .replace(/^[⚡🤖👤🌐🐙🔔]+\s*/u, '')
      .trim()
      .toLowerCase();
    const cleanBody = String(text || '')
      .replace(/\[(?:\/)?TEMPCHAT\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.!?;:,\s]+$/g, '')
      .toLowerCase();
    if (!cleanBody) return '';
    return quickHash(`${cleanSender}::${cleanBody}`);
  }

  function resolveEffectiveAgentAccessLevel(roleObj = {}, githubConfig = {}) {
    if (roleObj && roleObj.githubAccessLevel && roleObj.githubAccessLevel !== 'auto_role') {
      return String(roleObj.githubAccessLevel);
    }
    const defaultMode = String((githubConfig && githubConfig.defaultAgentAccessMode) || 'auto_role');
    if (defaultMode && defaultMode !== 'auto_role') {
      return defaultMode;
    }
    const titleLower = String((roleObj && (roleObj.roleTitle || roleObj.shortTitle || '')) || '').toLowerCase();
    if (roleObj && (roleObj.isSynthesizer || roleObj.isLeader)) {
      return 'push_and_pr';
    }
    if (/(?:\bqa\b|revisor|auditor|security\s+review|somente\s+leitura)/i.test(titleLower)) {
      return githubConfig && githubConfig.qaReadOnly ? 'read_only' : 'push_branch';
    }
    return githubConfig && githubConfig.branchMode === 'branch_per_agent_pr' ? 'push_and_pr' : 'push_branch';
  }

  function normalizeBoardKey(rawKey) {
    return String(rawKey || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9/_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  function createInitialSharedBoard(roles = [], roomId = '0000', githubConfig = null) {
    const assignments = {};
    (Array.isArray(roles) ? roles : []).forEach((r, idx) => {
      const slotKey = `ag${idx + 1}`;
      const name = r.shortTitle || r.agentName || `Agente ${idx + 1}`;
      const branch =
        githubConfig && githubConfig.enabled
          ? computeAgentBranchName(roomId, Object.assign({ index: idx, agentIndex: idx + 1 }, r), githubConfig)
          : '';
      assignments[slotKey] = {
        slotKey,
        agentIndex: idx + 1,
        agentName: name,
        roleTitle: r.roleTitle || 'Especialista',
        isSynthesizer: Boolean(r.isSynthesizer || r.isLeader),
        scope: r.roleDesc || r.roleTitle || '',
        files: '',
        branch,
        status: 'pendente', // 'pendente' | 'em_progresso' | 'bloqueado' | 'pronto_integracao' | 'concluido'
        notes: '',
        version: 1,
        updatedAt: Date.now()
      };
    });
    return {
      rev: 1,
      revision: 1,
      updatedAt: Date.now(),
      assignments,
      contracts: {}, // { [contractKey]: { key, spec, status, owner, version, updatedAt } }
      branches: {},
      pullRequests: {},
      gitRefs: {
        branches: {}, // { [branchName]: { name, sha, updatedAt } }
        pulls: {}     // { [prNum]: { number, title, state, merged, head, base, htmlUrl, updatedAt } }
      }
    };
  }

  function normalizeAssignmentStatusAlias(raw) {
    const s = String(raw || '').trim().toLowerCase();
    const map = {
      pendente: 'pendente',
      pending: 'pendente',
      em_progresso: 'em_progresso',
      in_progress: 'em_progresso',
      working: 'em_progresso',
      bloqueado: 'bloqueado',
      blocked: 'bloqueado',
      pronto_integracao: 'pronto_integracao',
      ready: 'pronto_integracao',
      review: 'pronto_integracao',
      pronto: 'pronto_integracao',
      concluido: 'concluido',
      completed: 'concluido',
      done: 'concluido'
    };
    return map[s] || '';
  }

  function upsertBoardAssignment(board, slotKeyRaw, patch = {}, authorName = '') {
    if (!board || typeof board !== 'object') return { changed: false };
    if (!board.assignments || typeof board.assignments !== 'object') board.assignments = {};
    const slotKey = normalizeBoardKey(slotKeyRaw || 'ag1') || 'ag1';
    const prev = board.assignments[slotKey] || {
      slotKey,
      agentIndex: Number((slotKey.match(/\d+/) || [1])[0]),
      agentName: authorName || slotKey.toUpperCase(),
      roleTitle: '',
      isSynthesizer: false,
      scope: '',
      files: '',
      branch: '',
      status: 'pendente',
      notes: '',
      summary: '',
      version: 0,
      updatedAt: 0
    };
    const mappedStatus = normalizeAssignmentStatusAlias(patch.status);
    const nextStatus = mappedStatus || prev.status;
    const nextScope = patch.scope !== undefined ? String(patch.scope).trim().slice(0, 400) : prev.scope;
    const nextFiles = patch.files !== undefined ? String(patch.files).trim().slice(0, 300) : prev.files;
    const rawNotes = patch.notes !== undefined ? patch.notes : patch.summary;
    const nextNotes = rawNotes !== undefined ? String(rawNotes).trim().slice(0, 500) : prev.notes;
    const nextBranch = patch.branch !== undefined ? String(patch.branch).trim().slice(0, 120) : prev.branch;
    const nextAgentName = patch.agentName ? String(patch.agentName).trim() : prev.agentName;

    const unchanged =
      prev.version > 0 &&
      prev.status === nextStatus &&
      prev.scope === nextScope &&
      prev.files === nextFiles &&
      prev.notes === nextNotes &&
      prev.branch === nextBranch &&
      prev.agentName === nextAgentName;
    if (unchanged) return { changed: false, item: prev };

    const updated = Object.assign({}, prev, {
      agentName: nextAgentName,
      status: nextStatus,
      scope: nextScope,
      files: nextFiles,
      notes: nextNotes,
      summary: nextNotes || nextScope,
      branch: nextBranch,
      updatedBy: authorName || nextAgentName,
      version: Number(prev.version || 0) + 1,
      updatedAt: Date.now()
    });
    board.assignments[slotKey] = updated;
    board.rev = Number(board.rev || 1) + 1;
    board.revision = board.rev;
    board.updatedAt = updated.updatedAt;
    return { changed: true, item: updated };
  }

  function upsertBoardContract(board, contractKeyRaw, patch = {}, authorName = '') {
    if (!board || typeof board !== 'object') return { changed: false };
    if (!board.contracts || typeof board.contracts !== 'object') board.contracts = {};
    const key = normalizeBoardKey(contractKeyRaw);
    if (!key) return { changed: false };
    if (patch && patch.delete) {
      if (board.contracts[key]) {
        delete board.contracts[key];
        board.rev = Number(board.rev || 1) + 1;
        board.revision = board.rev;
        board.updatedAt = Date.now();
        return { changed: true, deleted: true, key };
      }
      return { changed: false };
    }
    const prev = board.contracts[key] || null;
    const contractAlias = {
      rascunho: 'rascunho',
      proposed: 'rascunho',
      draft: 'rascunho',
      congelado: 'congelado',
      agreed: 'congelado',
      frozen: 'congelado',
      validado: 'validado',
      validated: 'validado'
    };
    const nextSpec = String(patch.spec !== undefined ? patch.spec : (prev && prev.spec) || '').trim().slice(0, 1200);
    if (!nextSpec) return { changed: false };
    const rawSt = String(patch.status || (prev && prev.status) || 'congelado').toLowerCase();
    const nextStatus = contractAlias[rawSt] || 'congelado';
    const nextOwner = String(patch.owner || authorName || (prev && prev.owner) || 'Equipe').trim();

    if (prev && prev.spec === nextSpec && prev.status === nextStatus) {
      return { changed: false, item: prev };
    }
    const updated = {
      key,
      spec: nextSpec,
      status: nextStatus,
      owner: nextOwner,
      version: prev ? Number(prev.version || 1) + 1 : 1,
      updatedAt: Date.now()
    };
    board.contracts[key] = updated;
    board.rev = Number(board.rev || 1) + 1;
    board.revision = board.rev;
    board.updatedAt = updated.updatedAt;
    return { changed: true, item: updated };
  }

  function extractBoardUpdatesFromText(rawReply, defaultSlotKey = 'ag1', authorName = 'Agente') {
    const text = String(rawReply || '').replace(/\[(?:HARNESS_REPORT|AU_AGENT_READY)\][\s\S]*?\[\/(?:HARNESS_REPORT|AU_AGENT_READY)\]/g, '');
    const assignments = [];
    const contracts = [];

    // 1. [ATRIBUICAO_UNICA ...] or [QUADRO_UNICO ...] (both attribute and pipe syntax!)
    const assignRx = /\[(?:ATRIBUICAO_(?:UNICA|ATUALIZAR)|QUADRO_UNICO)([^\]]*)\]([\s\S]*?)\[\/(?:ATRIBUICAO_(?:UNICA|ATUALIZAR)|QUADRO_UNICO)\]/gi;
    let am;
    while ((am = assignRx.exec(text)) !== null) {
      const attrs = am[1] || '';
      const rawBody = String(am[2] || '').trim();
      const slotM = attrs.match(/\bslot\s*=\s*["']?([^"'\s\]]+)/i);
      const stM = attrs.match(/\bstatus\s*=\s*["']?([^"'\s\]]+)/i);
      const filesM = attrs.match(/\b(?:arquivos|files)\s*=\s*["']([^"']+)["']/i);
      const brAttrM = attrs.match(/\bbranch\s*=\s*["']?([^"'\s\]]+)/i);

      let parsedStatus = (stM && stM[1]) || '';
      let parsedNotes = rawBody;
      let parsedBranch = (brAttrM && brAttrM[1]) || undefined;
      let parsedFiles = (filesM && filesM[1]) || undefined;

      if (!parsedStatus && rawBody.includes('|')) {
        const parts = rawBody.split('|').map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2 && normalizeAssignmentStatusAlias(parts[0])) {
          parsedStatus = normalizeAssignmentStatusAlias(parts[0]);
          const rest = [];
          for (let k = 1; k < parts.length; k++) {
            const bm = parts[k].match(/^branch\s*=\s*(.+)$/i);
            const fm = parts[k].match(/^(?:files|arquivos)\s*=\s*(.+)$/i);
            if (bm) parsedBranch = bm[1].trim();
            else if (fm) parsedFiles = fm[1].trim();
            else rest.push(parts[k]);
          }
          parsedNotes = rest.join(' | ');
        }
      }

      assignments.push({
        slotKey: (slotM && slotM[1]) || defaultSlotKey,
        status: normalizeAssignmentStatusAlias(parsedStatus) || 'em_progresso',
        files: parsedFiles,
        branch: parsedBranch,
        notes: parsedNotes || undefined,
        authorName
      });
    }

    // 2. [CONTRATO_UNICO chave="api/auth" status="congelado"]spec[/CONTRATO_UNICO] OR [CONTRATO_UNICO] api/auth | spec [/CONTRATO_UNICO]
    const contractRx = /\[CONTRATO_(?:UNICO|ATUALIZAR)([^\]]*)\]([\s\S]*?)\[\/CONTRATO_(?:UNICO|ATUALIZAR)\]/gi;
    let cm;
    while ((cm = contractRx.exec(text)) !== null) {
      const attrs = cm[1] || '';
      const rawBody = String(cm[2] || '').trim();
      const keyM = attrs.match(/\b(?:chave|key)\s*=\s*["']([^"']+)["']/i) || attrs.match(/\b(?:chave|key)\s*=\s*([^\s\]]+)/i);
      const stM = attrs.match(/\bstatus\s*=\s*["']?([^"'\s\]]+)/i);
      let cKey = (keyM && keyM[1]) || '';
      let cSpec = rawBody;
      if (!cKey && rawBody.includes('|')) {
        const idx = rawBody.indexOf('|');
        cKey = rawBody.slice(0, idx).trim();
        cSpec = rawBody.slice(idx + 1).trim();
      }
      if (cKey && cSpec) {
        contracts.push({
          key: cKey,
          status: (stM && stM[1]) || 'congelado',
          spec: cSpec,
          owner: authorName
        });
      }
    }

    // 3. Implicit readiness marker [MODULO_PRONTO_INTEGRACAO] or [ENTREGA_FINAL_PRONTA]
    if (/\[ENTREGA_FINAL_PRONTA\]/i.test(text)) {
      assignments.push({ slotKey: defaultSlotKey, status: 'concluido', authorName });
    } else if (/\[MODULO_PRONTO_INTEGRACAO\]/i.test(text)) {
      assignments.push({ slotKey: defaultSlotKey, status: 'pronto_integracao', authorName });
    }

    return { assignments, contracts };
  }

  function computeRoomIntegrationStatus(room = {}, nowMs = Date.now()) {
    const createdAt = Number(room.createdAt || nowMs);
    const timeoutMinutes = Math.max(3, Number(room.integrationTimeoutMinutes || 25));
    const deadlineAt = Number(room.integrationDeadlineAt || createdAt + timeoutMinutes * 60000);
    const remainingMs = Math.max(0, deadlineAt - nowMs);
    const isTimedOut = nowMs >= deadlineAt && room.status !== 'completed';
    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    const remainingLabel = isTimedOut ? '0m 00s (Prazo Esgotado!)' : `${mins}m ${String(secs).padStart(2, '0')}s`;

    const maxRounds = Math.max(2, Number(room.maxRoundsBeforeSynthesis || 6));
    const openAgents = (Array.isArray(room.agents) ? room.agents : []).filter(
      (a) => !a.closed && a.screeningStatus !== 'refused_stopped'
    );
    const currentRound = openAgents.reduce((mx, a) => Math.max(mx, Number(a.turnsCount || 0)), 0) + 1;

    const boardAssigns = (room.sharedBoard && room.sharedBoard.assignments) || {};
    const nonSynthSlots = Object.values(boardAssigns).filter((a) => !a.isSynthesizer);
    const targetSlots = nonSynthSlots.length > 0 ? nonSynthSlots : Object.values(boardAssigns);
    const expectedCount = Math.max(1, targetSlots.length || openAgents.length || 1);
    const readySlots = targetSlots.filter((a) => a.status === 'pronto_integracao' || a.status === 'concluido');
    const readyCount = readySlots.length;
    const allModulesReady = targetSlots.length > 0 && readyCount >= targetSlots.length;

    let state = 'implementing';
    if (room.status === 'completed' || Boolean(room.finalDeliverable)) {
      state = 'completed';
    } else if (room.forceReadyForSynthesis || allModulesReady || currentRound > maxRounds) {
      state = 'ready_for_synthesis';
    } else if (isTimedOut) {
      state = 'timed_out_ready';
    } else if (Number(room.seq || 0) <= 1 && currentRound <= 1) {
      state = 'bootstrap';
    } else if (readyCount > 0 && readyCount < expectedCount) {
      state = 'awaiting_peers';
    }

    const stateLabels = {
      bootstrap: '🟡 Inicializando Equipe & Contratos',
      implementing: '🔵 Implementação Paralela em Andamento',
      awaiting_peers: `🟣 Aguardando Módulos Pendentes (${readyCount}/${expectedCount} prontos)`,
      ready_for_synthesis: `🟢 PRONTO P/ INTEGRAÇÃO FINAL (${readyCount}/${expectedCount} módulos prontos!)`,
      timed_out_ready: '⏰ TEMPO LIMITE ATINGIDO — CONSOLIDAR INTEGRAÇÃO FINAL AGORA!',
      completed: '✅ Integração Final Concluída'
    };

    const labelTxt = stateLabels[state] || state;
    const readyFlag = state === 'ready_for_synthesis' || state === 'timed_out_ready' || state === 'completed';
    return {
      state,
      label: labelTxt,
      stateLabel: labelTxt,
      isIntegrationReady: readyFlag,
      isReadyForSynthesis: readyFlag,
      isTimedOut,
      timeoutMinutes,
      deadlineAt,
      remainingMs,
      remainingLabel,
      readyCount,
      expectedCount,
      totalActive: expectedCount,
      currentRound,
      maxRounds
    };
  }

  function normalizeClaimedPaths(filesStr) {
    if (!filesStr) return [];
    return String(filesStr)
      .split(/[,;|\n]+|\s{2,}/)
      .map((s) =>
        s
          .trim()
          .replace(/^[`"']+|[`"']+$/g, '')
          .replace(/^\.\//, '')
          .replace(/\/+$/, '')
      )
      .filter((s) => s.length >= 2 && !/^(?:tbd|todo|nenhum|n\/a|definindo|-+|\*)$/i.test(s));
  }

  function detectBoardFileOverlaps(board) {
    if (!board || !board.assignments || typeof board.assignments !== 'object') return [];
    const entries = Object.values(board.assignments)
      .map((a) => ({
        slotKey: String(a.slotKey || ''),
        agentName: String(a.agentName || a.slotKey || 'Agente'),
        paths: normalizeClaimedPaths(a.files)
      }))
      .filter((e) => e.paths.length > 0);

    const overlaps = [];
    const seenPairs = new Set();
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const A = entries[i];
        const B = entries[j];
        for (const pA of A.paths) {
          const baseA = pA.replace(/\/?\*+$/, '');
          const isWildA = pA.endsWith('*');
          for (const pB of B.paths) {
            const baseB = pB.replace(/\/?\*+$/, '');
            const isWildB = pB.endsWith('*');
            const lowerA = pA.toLowerCase();
            const lowerB = pB.toLowerCase();
            const lowerBaseA = baseA.toLowerCase();
            const lowerBaseB = baseB.toLowerCase();
            const collides =
              lowerA === lowerB ||
              (isWildA && lowerBaseA && (lowerBaseB === lowerBaseA || lowerB.startsWith(lowerBaseA + '/'))) ||
              (isWildB && lowerBaseB && (lowerBaseA === lowerBaseB || lowerA.startsWith(lowerBaseB + '/')));
            if (collides) {
              const target = pA.length <= pB.length ? pA : pB;
              const dedupKey = `${A.slotKey}:${B.slotKey}:${target.toLowerCase()}`;
              if (!seenPairs.has(dedupKey)) {
                seenPairs.add(dedupKey);
                overlaps.push({
                  path: target,
                  agents: [A.agentName, B.agentName],
                  slots: [A.slotKey, B.slotKey]
                });
              }
            }
          }
        }
      }
    }
    return overlaps;
  }

  function formatSharedBoardSection(board, integrationInfo) {
    if (!board || typeof board !== 'object') return '';
    const lines = [];
    if (integrationInfo) {
      lines.push(
        `⏱️ ESTADO & TEMPO LIMITE DA INTEGRAÇÃO FINAL: ${integrationInfo.stateLabel} | Prazo restante: ${integrationInfo.remainingLabel} | Rodada ${integrationInfo.currentRound}/${integrationInfo.maxRounds} | Módulos prontos: ${integrationInfo.readyCount}/${integrationInfo.expectedCount}`
      );
      if (integrationInfo.isIntegrationReady && integrationInfo.state !== 'completed') {
        lines.push(
          '🎯 GATILHO DE INTEGRAÇÃO FINAL ATIVO: Todos os módulos atingiram prontidão (ou o tempo limite de SLA chegou). O Líder Integrador já deve consolidar branches/arquivos reais de todos os colegas, validar e emitir [ENTREGA_FINAL_PRONTA]!'
        );
      }
    }

    const assignList = Object.values(board.assignments || {});
    const contractList = Object.values(board.contracts || {});
    const prList = Object.values((board.gitRefs && board.gitRefs.pulls) || {});
    const brList = Object.values((board.gitRefs && board.gitRefs.branches) || {});
    const overlaps = detectBoardFileOverlaps(board);

    lines.push('');
    lines.push(`🗺️ DIVISÃO VIVA DO TIME & QUADRO COMPARTILHADO DE ATRIBUIÇÕES & CONTRATOS (rev #${board.rev || 1}):`);
    if (assignList.length > 0) {
      assignList.forEach((a) => {
        const slotNum = String(a.slotKey || '').replace(/\D+/g, '') || '1';
        const brBadge = a.branch ? ` | branch: \`${a.branch}\`` : '';
        const filesBadge = a.files ? ` | arquivos exclusivos: \`${a.files}\`` : ' | arquivos: *(ainda não reivindicados — use `/tmp/au_chat claim`!)*';
        const noteBadge = a.notes ? ` — ${a.notes}` : '';
        lines.push(`  • [@Agente${slotNum} • ${a.status.toUpperCase()}] ${a.agentName} (${a.roleTitle})${brBadge}${filesBadge}${noteBadge}`);
      });
    }
    if (overlaps.length > 0) {
      lines.push('  ⚠️ ALERTA DE SOBREPOSIÇÃO DE ARQUIVOS (RESOLVAM IMEDIATAMENTE NO TEMPCHAT!):');
      overlaps.forEach((ov) => {
        lines.push(
          `    - CONFLITO em \`${ov.path}\` reivindicado por **${ov.agents[0]}** e **${ov.agents[1]}** -> Conversem agora com @Menção para definir quem assume \`${ov.path}\` sem retrabalho!`
        );
      });
    }
    if (contractList.length > 0) {
      lines.push('  📜 Contratos Ativos Acordados pelo Time (Fonte Única):');
      contractList.forEach((c) => {
        lines.push(`    - [${c.key} • v${c.version} • ${c.status}] (por ${c.owner}): ${c.spec}`);
      });
    } else {
      lines.push('  📜 Contratos Ativos: nenhum registrado ainda (publique interfaces compartilhadas com `/tmp/au_chat contract "chave" "assinatura/schema"`).');
    }
    if (prList.length > 0 || brList.length > 0) {
      const openPrs = prList.filter((p) => p.state === 'open' || p.merged);
      if (openPrs.length > 0) {
        lines.push(
          '  🔔 PRs Detectados pelo Radar Git: ' +
            openPrs.map((p) => `PR #${p.number} [${p.merged ? 'MERGED' : p.state}] (${p.head}->${p.base}) ${p.htmlUrl}`).join(' | ')
        );
      }
      if (brList.length > 0) {
        lines.push(
          '  🌿 Branches no Repositório: ' +
            brList.slice(0, 12).map((b) => `${b.name}${b.sha ? `@${String(b.sha).slice(0, 7)}` : ''}`).join(', ')
        );
      }
    }
    return lines.join('\n');
  }

  function buildRealtimeChatInstructions(opts = {}) {
    const binId = opts.filebinId || '';
    if (!binId) return '';
    const roomIdStr = String(opts.roomId || '0000');
    const agentIdx = Number(opts.agentIndex || 1);
    const tag = `ag${agentIdx}`;
    const safeSender = JSON.stringify(String(opts.agentName || `Agente ${agentIdx}`));
    const safeRole = JSON.stringify(String(opts.roleTitle || 'Especialista'));
    const safeRoomId = JSON.stringify(roomIdStr);
    const safeHmacKey = JSON.stringify(String(opts.roomHmacKey || ''));
    const rawCursor = Math.max(0, Number(opts.minTimestampMs || opts.lastSeenSeq || 0));
    const minTsCursor = rawCursor >= 1000000000000 ? rawCursor : 0;

    // On Round 2+, avoid re-injecting ~7,500 chars of Python source! Restore from persistent /home/user/au_state/au_chat in 1 line.
    if (opts.compactReminderOnly) {
      return [
        '',
        `⚡ LEMBRETE RÁPIDO \`/tmp/au_chat\` (Sala #${roomIdStr} • Sua Identidade: @Agente${agentIdx} — ${opts.agentName || `Agente ${agentIdx}`}):`,
        '- Garanta o binário persistente no início do bash: `[ -x /tmp/au_chat ] || cp -f /home/user/au_state/au_chat /tmp/au_chat 2>/dev/null && chmod +x /tmp/au_chat 2>/dev/null || true`',
        '- Sincronizar mensagens novas + mapa de quem faz o quê: `/tmp/au_chat sync`',
        '- Conversar / perguntar / responder direto a colegas: `/tmp/au_chat ask "@Agente2" "dúvida/proposta"` | `/tmp/au_chat reply "@Agente1" "acordo/resposta"` | `/tmp/au_chat send "@Todos ..."`',
        '- Atualizar seus arquivos exclusivos ou contratos sem duplicar: `/tmp/au_chat claim "pasta/arquivos" "meu escopo"` | `/tmp/au_chat contract "api/x" "schema"` | `/tmp/au_chat ready "resumo validado"`'
      ].join('\n');
    }

    return [
      '',
      `⚡ CHAT EM TEMPO REAL + QUADRO ÚNICO DE CONTRATOS/ATRIBUIÇÕES (Sala #${roomIdStr} • Sua Identidade: @Agente${agentIdx} • Paralelo Assinado HMAC):`,
      'IMPORTANTE: Instale `/tmp/au_chat` (também salvo em `/home/user/au_state/au_chat` para persistir em todas as rodadas!) logo no seu **1º comando bash** para conversar AO VIVO, dividir arquivos e negociar contratos com toda a equipe:',
      '```bash',
      'cat << \'EOF\' > /tmp/au_chat',
      '#!/usr/bin/env python3',
      'import sys, os, re, json, time, hmac, fcntl, random, hashlib, urllib.request, concurrent.futures',
      `ROOM_ID = ${safeRoomId}`,
      `BIN_ID = "${binId}"`,
      `TAG = "${tag}"`,
      `MY_HANDLE = "@Agente${agentIdx}"`,
      `SENDER = ${safeSender}`,
      `ROLE = ${safeRole}`,
      `ROOM_HMAC_KEY = ${safeHmacKey}`,
      `MIN_TS_CURSOR = ${minTsCursor}`,
      'STATE_DIR = os.environ.get("AU_STATE_DIR", "/home/user/au_state")',
      'try: os.makedirs(STATE_DIR, exist_ok=True)',
      'except Exception: STATE_DIR = "/tmp"',
      `SEEN = os.path.join(STATE_DIR, "au_seen_${binId}_${tag}.json")`,
      'LOCK_FILE = SEEN + ".lock"',
      'HDR = {"User-Agent": "curl/8.5.0", "Accept": "application/json", "cid": "au-rt"}',
      'GLOBAL_DEADLINE_S = 12.0',
      'PER_REQ_TIMEOUT_S = 4.5',
      'MAX_PAGE_FILES = 50',
      'def fp(sender, txt):',
      '    s = re.sub(r"^[⚡🤖👤🌐🐙🔔📌❓🤝]+\\s*", "", str(sender or "")).strip().lower()',
      '    t = re.sub(r"\\s+", " ", str(txt or "")).strip().lower()',
      '    return hashlib.sha1(f"{s}::{t}".encode("utf-8")).hexdigest()[:20]',
      'def sign_payload(room_id, seq_or_id, author, ts, txt):',
      '    if not ROOM_HMAC_KEY: return ""',
      '    try:',
      '        raw_key = bytes.fromhex(ROOM_HMAC_KEY)',
      '        canon = "\\n".join([str(room_id or ""), str(seq_or_id or ""), str(seq_or_id or ""), str(author or ""), str(ts or ""), str(txt or "")])',
      '        return hmac.new(raw_key, canon.encode("utf-8"), hashlib.sha256).hexdigest()',
      '    except Exception: return ""',
      'def verify_payload(m):',
      '    if not ROOM_HMAC_KEY: return True',
      '    sig = str(m.get("hmacSig") or "")',
      '    if not sig: return False',
      '    exp = sign_payload(m.get("roomId", ROOM_ID), m.get("id") or m.get("seq") or "", m.get("tag") or m.get("sender") or "", m.get("ts") or "", m.get("text") or "")',
      '    return bool(exp) and hmac.compare_digest(exp, sig.lower())',
      'def load_state():',
      '    if os.path.exists(SEEN):',
      '        try:',
      '            with open(SEEN, "r", encoding="utf-8") as f: return json.load(f)',
      '        except Exception: pass',
      '    return {"files": [], "fps": {}, "sent": {}, "lastTs": MIN_TS_CURSOR}',
      'def save_state(st):',
      '    st["files"] = st.get("files", [])[-600:]',
      '    tmp = f"{SEEN}.tmp.{os.getpid()}.{random.randint(100,999)}"',
      '    try:',
      '        with open(LOCK_FILE, "a+", encoding="utf-8") as lf:',
      '            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)',
      '            with open(tmp, "w", encoding="utf-8") as tf:',
      '                json.dump(st, tf)',
      '                tf.flush(); os.fsync(tf.fileno())',
      '            os.replace(tmp, SEEN)',
      '            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)',
      '    except Exception:',
      '        try: os.unlink(tmp)',
      '        except Exception: pass',
      'def post_json(fn, obj):',
      '    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")',
      '    try:',
      '        req = urllib.request.Request(f"https://filebin.net/{BIN_ID}/{fn}", data=body, method="POST", headers={"User-Agent": "curl/8.5.0", "Content-Type": "application/json", "Accept": "application/json", "cid": "au-rt"})',
      '        with urllib.request.urlopen(req, timeout=8) as r: r.read(); return "filebin"',
      '    except Exception as primary_err:',
      '        try:',
      '            req2 = urllib.request.Request("https://x0.at/", data=b"--au\\r\\nContent-Disposition: form-data; name=\\"file\\"; filename=\\"" + fn.encode() + b"\\"\\r\\nContent-Type: application/json\\r\\n\\r\\n" + body + b"\\r\\n--au--\\r\\n", method="POST", headers={"Content-Type": "multipart/form-data; boundary=au", "User-Agent": "curl/8.5.0"})',
      '            with urllib.request.urlopen(req2, timeout=8) as r2: return r2.read().decode("utf-8", errors="ignore").strip()',
      '        except Exception: raise primary_err',
      'def do_send(text):',
      '    text = re.sub(r"```[\\s\\S]*?```", "[trecho de código no workspace/branch]", text or "").strip()',
      '    if len(text) > 750: text = text[:745] + "..."',
      '    if not text: return',
      '    st = load_state(); h = fp(SENDER, text); now = time.time()',
      '    if now - float(st.get("sent", {}).get(h, 0)) < 45:',
      '        print("ℹ️ [Deduplicado: mensagem idêntica já enviada recentemente]"); return',
      '    time.sleep(random.uniform(0.300, 0.750))  # Agent-only jitter; coordinator uses the extension, never this queue',
      '    now = time.time()',
      '    ts = int(now * 1000)',
      '    msg_id = f"m_{ts}_{TAG}_{random.randint(100,999)}"',
      '    fn = f"auchat_{ts}_{TAG}_{random.randint(100,999)}.json"',
      '    sig = sign_payload(ROOM_ID, msg_id, TAG, ts, text)',
      '    try:',
      '        post_json(fn, {"id": msg_id, "roomId": ROOM_ID, "sender": SENDER, "role": ROLE, "tag": TAG, "text": text, "fp": h, "ts": ts, "hmacSig": sig})',
      '        st.setdefault("sent", {})[h] = now; st.setdefault("fps", {})[h] = now; save_state(st)',
      '        print(f"⚡ [ENVIADO AO VIVO NA SALA #{ROOM_ID}]: {text}")',
      '    except Exception as e: print(f"[Aviso TempChat]: {e}", file=sys.stderr)',
      'def fetch_one_msg(fn, deadline):',
      '    rem = deadline - time.monotonic()',
      '    if rem <= 0.25: return (fn, None, False)',
      '    try:',
      '        g = urllib.request.Request(f"https://filebin.net/{BIN_ID}/{fn}", headers=HDR)',
      '        with urllib.request.urlopen(g, timeout=min(PER_REQ_TIMEOUT_S, rem)) as gr:',
      '            return (fn, json.loads(gr.read().decode("utf-8")), True)',
      '    except Exception:',
      '        return (fn, None, False)',
      'def do_read():',
      '    deadline = time.monotonic() + GLOBAL_DEADLINE_S',
      '    st = load_state(); seen_files = set(st.get("files", [])); seen_fps = st.get("fps", {})',
      '    min_ts = MIN_TS_CURSOR',
      '    req = urllib.request.Request(f"https://filebin.net/{BIN_ID}", headers=HDR)',
      '    try:',
      '        with urllib.request.urlopen(req, timeout=min(6.0, max(1.0, deadline - time.monotonic()))) as r:',
      '            data = json.loads(r.read().decode("utf-8"))',
      '    except Exception: return 0',
      '    all_files = sorted([f.get("filename", "") for f in (data.get("files") or []) if f.get("filename", "").startswith("auchat_") and f.get("filename", "").endswith(".json")])',
      '    unread = []',
      '    for fn in all_files:',
      '        if fn in seen_files: continue',
      '        if f"_{TAG}_" in fn:',
      '            seen_files.add(fn); continue',
      '        m_ts = re.match(r"^auchat_(\\d+)_", fn)',
      '        if m_ts and min_ts > 0 and int(m_ts.group(1)) < min_ts:',
      '            seen_files.add(fn); continue',
      '        unread.append(fn)',
      '    page = unread[-MAX_PAGE_FILES:]',
      '    if not page:',
      '        st["files"] = sorted(seen_files); save_state(st); return 0',
      '    fetched_ok = []',
      '    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:',
      '        futs = [pool.submit(fetch_one_msg, fn, deadline) for fn in page]',
      '        for fut in futs:',
      '            rem = max(0.05, deadline - time.monotonic())',
      '            try:',
      '                fn, m_obj, ok = fut.result(timeout=rem)',
      '                if ok and isinstance(m_obj, dict):',
      '                    seen_files.add(fn)',
      '                    fetched_ok.append((fn, m_obj))',
      '            except Exception: pass',
      '    msgs = []',
      '    max_seen_ts = min_ts',
      '    for fn, m in sorted(fetched_ok, key=lambda x: x[0]):',
      '        m_room = str(m.get("roomId") or ROOM_ID)',
      '        if m_room != ROOM_ID: continue',
      '        h = m.get("fp") or fp(m.get("sender", ""), m.get("text", ""))',
      '        if h in seen_fps: continue',
      '        seen_fps[h] = time.time()',
      '        if int(m.get("ts") or 0) > max_seen_ts: max_seen_ts = int(m.get("ts") or 0)',
      '        m["_verified"] = verify_payload(m)',
      '        msgs.append(m)',
      '    st["files"] = sorted(seen_files); st["fps"] = seen_fps; st["lastTs"] = max_seen_ts; save_state(st)',
      '    if msgs: print(f"🔔 NOTIFICAÇÃO: {len(msgs)} mensagem(ns) nova(s) na sala #{ROOM_ID}; leia e responda às menções.")',
      '    for m in msgs:',
      '        who = m.get("sender", "Colega"); txt = m.get("text", "")',
      '        v_tag = "" if m.get("_verified", True) else " [⛔ NÃO VERIFICADO]"',
      '        direct = " 🎯[PARA VOCÊ]" if mentions_me(txt) else ""',
      '        prefix = "🔔" if m.get("tag") == "gitradar" else "💬"',
      '        print(f"{prefix}{direct} [AO VIVO • {who}{v_tag}]: {txt}")',
      '    return len(msgs)',
      'def do_board():',
      '    try:',
      '        g = urllib.request.Request(f"https://filebin.net/{BIN_ID}/au_board_state.json", headers=HDR)',
      '        with urllib.request.urlopen(g, timeout=8) as gr: b = json.loads(gr.read().decode("utf-8"))',
      '    except Exception:',
      '        print("📋 Quadro compartilhado inicializando — use `/tmp/au_chat claim` e `/tmp/au_chat contract`."); return',
      '    integ = b.get("integration") or {}',
      '    print(f"⏱️ INTEGRAÇÃO: {integ.get(\'stateLabel\', \'Em andamento\')} | Prazo: {integ.get(\'remainingLabel\', \'--\')} | Prontos: {integ.get(\'readyCount\', 0)}/{integ.get(\'expectedCount\', 1)}")',
      '    print(f"🗺️ QUEM FAZ O QUÊ (rev #{b.get(\'rev\', 1)}):")',
      '    for k, a in (b.get("assignments") or {}).items():',
      '        print(f"  • [{k.upper()} • {a.get(\'status\')}] {a.get(\'agentName\')} | arquivos={a.get(\'files\',\'(pendente)\')} | {a.get(\'notes\',\'\')}")',
      '    cs = b.get("contracts") or {}',
      '    if cs:',
      '        print("📜 CONTRATOS ACORDADOS:")',
      '        for k, c in cs.items(): print(f"  • [{k} v{c.get(\'version\',1)} • {c.get(\'status\')}] ({c.get(\'owner\')}): {c.get(\'spec\')}")',
      'def mentions_me(txt):',
      '    body = txt.casefold()',
      '    aliases = [SENDER.casefold(), ROLE.casefold(), MY_HANDLE[1:].casefold(), "agente " + MY_HANDLE[7:], TAG.casefold()]',
      '    if any(v.strip() in aliases for v in re.findall(r"@\\[([^\\]\\n]+)\\]", body)): return True',
      '    return bool(re.search(r"@(?:todos|all|equipe|time)\\b", body)) or any(re.search(r"@" + re.escape(a) + r"(?![\\w])", body) for a in aliases if a)',
      'def timer_footer():',
      '    tf = os.path.join(STATE_DIR, f"au_timer_{ROOM_ID}_{TAG}.json")',
      '    if not os.path.exists(tf): return',
      '    try:',
      '        with open(tf, "r", encoding="utf-8") as f: td = json.load(f)',
      '        rem = float(td.get("startedAt", 0)) + float(td.get("targetSec", 3600)) - time.time()',
      '        now_s = time.strftime("%H:%M:%S", time.localtime())',
      '        if rem > 0:',
      '            rm, rs = int(rem // 60), int(rem % 60)',
      '            print(f"⏱️ [HORÁRIO REAL {now_s} | Faltam {rm}m {rs:02d}s no timer mínimo | CAN_FINISH=NO — NÃO encerre a sessão!]")',
      '        else:',
      '            print(f"✅ [HORÁRIO REAL {now_s} | Timer mínimo cumprido | CAN_FINISH=YES]")',
      '    except Exception: pass',
      'cmd = sys.argv[1] if len(sys.argv) > 1 else "sync"',
      'if cmd == "send": do_send(" ".join(sys.argv[2:])); timer_footer()',
      'elif cmd == "ask":',
      '    target = sys.argv[2] if len(sys.argv) > 2 else "@Todos"',
      '    q = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else ""',
      '    do_send(f"❓ [{MY_HANDLE} -> {target}]: {q}"); timer_footer()',
      'elif cmd == "reply":',
      '    target = sys.argv[2] if len(sys.argv) > 2 else "@Todos"',
      '    ans = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else ""',
      '    do_send(f"🤝 [{MY_HANDLE} em resposta a {target}]: {ans}"); timer_footer()',
      'elif cmd == "claim":',
      '    files_val = sys.argv[2] if len(sys.argv) > 2 else ""',
      '    notes_val = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else "Escopo reivindicado"',
      '    post_json(f"auboard_assign_{TAG}.json", {"op": "assign", "slotKey": TAG, "agentName": SENDER, "status": "em_progresso", "files": files_val, "notes": notes_val, "ts": int(time.time()*1000)})',
      '    do_send(f"📌 [{MY_HANDLE} DIVISÃO DE PAPEL]: Assumi exclusivamente `{files_val}` — {notes_val}. Alguém tem dependência ou ajuste nesse limite?")',
      '    timer_footer()',
      'elif cmd in ("sync", "board", "notifications", "inbox") or (cmd == "status" and len(sys.argv) <= 2): do_board(); do_read(); timer_footer()',
      'elif cmd in ("assign", "status"):',
      '    st_val = sys.argv[2] if len(sys.argv) > 2 else "em_progresso"',
      '    files_val = sys.argv[3] if len(sys.argv) > 4 else ""',
      '    notes_val = " ".join(sys.argv[4:]) if len(sys.argv) > 4 else (sys.argv[3] if len(sys.argv) == 4 else "")',
      '    post_json(f"auboard_assign_{TAG}.json", {"op": "assign", "slotKey": TAG, "agentName": SENDER, "status": st_val, "files": files_val, "notes": notes_val, "ts": int(time.time()*1000)})',
      '    print(f"📋 [ATRIBUIÇÃO ÚNICA ATUALIZADA]: {TAG.upper()} -> {st_val} ({notes_val or files_val})")',
      '    timer_footer()',
      'elif cmd == "ready":',
      '    notes_val = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else "Módulo validado e pronto para integração final"',
      '    post_json(f"auboard_assign_{TAG}.json", {"op": "assign", "slotKey": TAG, "agentName": SENDER, "status": "pronto_integracao", "notes": notes_val, "ts": int(time.time()*1000)})',
      '    do_send(f"✅ [{MY_HANDLE} PRONTO P/ INTEGRAÇÃO]: {notes_val}")',
      '    timer_footer()',
      'elif cmd == "contract":',
      '    ckey = re.sub(r"[^a-z0-9/_.-]+", "-", (sys.argv[2] if len(sys.argv) > 2 else "geral").lower()).strip("-")',
      '    spec_val = sys.argv[3] if len(sys.argv) > 3 else ""',
      '    cst = sys.argv[4] if len(sys.argv) > 4 else "congelado"',
      '    safe_fn = re.sub(r"[^a-z0-9_.-]+", "_", ckey)[:48]',
      '    post_json(f"auboard_contract_{safe_fn}.json", {"op": "contract", "key": ckey, "spec": spec_val, "status": cst, "owner": SENDER, "ts": int(time.time()*1000)})',
      '    do_send(f"📜 [{MY_HANDLE} CONTRATO `{ckey}` ({cst})]: {spec_val}")',
      '    timer_footer()',
      'elif cmd == "wait":',
      '    limit = min(22, int(sys.argv[2]) if len(sys.argv) > 2 else 15)',
      '    w = 0',
      '    while w < limit:',
      '        if do_read() > 0: timer_footer(); sys.exit(0)',
      '        time.sleep(3); w += 3',
      '    timer_footer()',
      'else: do_read(); timer_footer()',
      'EOF',
      'mkdir -p /home/user/au_state && cp -f /tmp/au_chat /home/user/au_state/au_chat && chmod +x /tmp/au_chat /home/user/au_state/au_chat',
      '```',
      'Comandos de Conversa & Organização do Time (sem poluir o chat com código bruto!):',
      '- Menção direta: `/tmp/au_chat ask "@[Nome exato do agente]" "mensagem"` ou `/tmp/au_chat send "@[Nome exato do agente] mensagem"`. Veja os nomes no quadro; @AgenteN continua válido. Mensagens são públicas na sala, não privadas.',
      '- `/tmp/au_chat notifications` (ou `inbox`) — consulta mensagens novas, com alerta 🔔 e destaque 🎯 para suas menções. Use entre etapas de trabalho; `wait 18` / timer pulse também notificam.',
      '- `/tmp/au_chat sync` — vê o **Mapa de Quem Faz o Quê** + **Mensagens Novas dos Colegas** (destaca `🎯[PARA VOCÊ]`).',
      '- `/tmp/au_chat claim "src/modulo/*" "O que vou construir"` — reivindica seus arquivos exclusivos no Quadro E avisa a equipe!',
      '- `/tmp/au_chat ask "@Agente2" "Como quer o formato do payload X?"` | `/tmp/au_chat reply "@Agente1" "Fechado, uso esse contrato!"` — diálogo direto entre colegas!',
      '- `/tmp/au_chat contract "api/auth" "POST /login -> {token}" congelado` | `/tmp/au_chat ready "Módulo testado"` | `/tmp/au_chat wait 15`.'
    ].join('\n');
  }

  function formatSessionTimerLabel(minutes) {
    const mins = Math.max(0, Math.round(Number(minutes || 0)));
    if (mins <= 0) return '';
    if (mins === 60) return '1 hora (60 min)';
    if (mins === 120) return '2 horas (120 min)';
    if (mins % 60 === 0) return `${mins / 60} horas (${mins} min)`;
    if (mins > 60) return `${Math.floor(mins / 60)}h ${mins % 60}min (${mins} min)`;
    return `${mins} minutos`;
  }

  function buildSessionTimerInstructions(opts = {}) {
    const rawMins =
      opts.sessionTimerMinutes !== undefined
        ? Number(opts.sessionTimerMinutes)
        : global.AU_DEFAULTS && global.AU_DEFAULTS.DEFAULT_SETTINGS
          ? Number(global.AU_DEFAULTS.DEFAULT_SETTINGS.sessionMinTimerMinutes || 60)
          : 60;
    const targetMinutes = Number.isFinite(rawMins) ? Math.min(480, Math.max(0, Math.round(rawMins))) : 60;
    if (targetMinutes <= 0) return '';

    const agentIdx = Math.max(1, Number(opts.agentIndex || 1));
    const tag = `${String(opts.roomId || 'solo').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}_ag${agentIdx}`;
    const hasChat = opts.hasChat !== false;
    const durationLabel = formatSessionTimerLabel(targetMinutes);

    return [
      '',
      `⏱️ TIMER OBRIGATÓRIO DE SESSÃO NO RELÓGIO REAL (Mínimo: ${durationLabel} • PROIBIDO SUPOR HORÁRIO!):`,
      `- **REGRA DE DURAÇÃO MÍNIMA (${durationLabel})**: Você **SÓ É PERMITIDO encerrar esta sessão/turno após cumprir no mínimo ${durationLabel} no relógio real do sistema**! Isso evita turnos curtos e evita spam de prompts repetidos.`,
      '- **PROIBIDO SUPOR OU CHUTAR QUE O TEMPO PASSOU**: Modelos NUNCA sabem quanto tempo real passou sem consultar o relógio! Você **DEVE rodar `/tmp/au_timer check` (ou `/tmp/au_timer pulse 18`) repetidamente no `bash`** para conferir o horário real (`HH:MM:SS`). Enquanto sair `CAN_FINISH=NO`, **NÃO finalize sua resposta** — continue codando, testando casos de borda, revisando arquivos e conversando com a equipe!' +
        ' *(Atenção: nunca use `sleep 3600` num único bash; alterne trabalho real + `/tmp/au_chat` + `/tmp/au_timer pulse 18` em ciclos curtos de <22s!)*',
      'EXCEÇÕES PRIORITÁRIAS: pare imediatamente por ordem do usuário, falta de créditos/tokens, erro irrecuperável ou segurança. Não execute ações inúteis nem loops apertados só para preencher tempo. Se o Arena interromper o turno, o timer persistido não deve reiniciar.',
      'Instale e inicie `/tmp/au_timer` (persistido em `/home/user/au_state/au_timer`) agora mesmo no seu **1º comando bash**:',
      '```bash',
      'cat << \'EOF\' > /tmp/au_timer',
      '#!/usr/bin/env python3',
      'import sys, os, json, time, subprocess',
      'from datetime import datetime, timezone',
      `TAG = "${tag}"`,
      `DEFAULT_MIN = ${targetMinutes}`,
      'STATE_DIR = os.environ.get("AU_STATE_DIR", "/home/user/au_state")',
      'try: os.makedirs(STATE_DIR, exist_ok=True)',
      'except Exception: STATE_DIR = "/tmp"',
      'TIMER_FILE = os.path.join(STATE_DIR, f"au_timer_{TAG}.json")',
      'def fmt_clock(epoch):',
      '    return datetime.fromtimestamp(epoch).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")',
      'def fmt_dur(sec):',
      '    sec = max(0, int(round(sec)))',
      '    h, rem = divmod(sec, 3600); m, s = divmod(rem, 60)',
      '    return f"{h}h {m:02d}m {s:02d}s" if h > 0 else f"{m}m {s:02d}s"',
      'def load_timer():',
      '    if os.path.exists(TIMER_FILE):',
      '        try:',
      '            with open(TIMER_FILE, "r", encoding="utf-8") as f: return json.load(f)',
      '        except Exception: pass',
      '    return None',
      'def save_timer(st):',
      '    tmp = TIMER_FILE + f".tmp.{os.getpid()}"',
      '    with open(tmp, "w", encoding="utf-8") as f: json.dump(st, f)',
      '    os.replace(tmp, TIMER_FILE)',
      'def start_or_reset(mins, force_reset=False):',
      '    now = time.time(); cur = load_timer()',
      '    if not force_reset and cur and (float(cur.get("startedAt", 0)) + float(cur.get("targetSec", mins*60)) > now):',
      '        return cur',
      '    st = {"startedAt": now, "targetSec": max(60, int(float(mins) * 60)), "checks": 0, "lastCheckAt": now}',
      '    save_timer(st); return st',
      'def do_check():',
      '    now = time.time()',
      '    st = load_timer() or start_or_reset(DEFAULT_MIN, False)',
      '    st["checks"] = int(st.get("checks", 0)) + 1',
      '    st["lastCheckAt"] = now; save_timer(st)',
      '    started = float(st["startedAt"]); target = float(st["targetSec"])',
      '    elapsed = max(0.0, now - started); rem = (started + target) - now',
      '    if rem > 0:',
      '        print(f"⏳ [HORÁRIO REAL: {fmt_clock(now)}] Decorrido: {fmt_dur(elapsed)} / {fmt_dur(target)} | Liberação às: {fmt_clock(started + target)} | FALTAM: {fmt_dur(rem)} | Checagem #{st[\'checks\']} | CAN_FINISH=NO")',
      '        print("🚫 BLOQUEADO PELA REGRA DO TIMER: AINDA NÃO PASSOU O TEMPO! Continue trabalhando, testando e interagindo no chat, e confira `/tmp/au_timer check` novamente!")',
      '        return False',
      '    print(f"✅ [HORÁRIO REAL: {fmt_clock(now)}] Decorrido: {fmt_dur(elapsed)} / {fmt_dur(target)} | Checagem #{st[\'checks\']} | CAN_FINISH=YES")',
      '    print("🟢 TIMER REAL CUMPRIDO! Você já cumpriu o tempo mínimo obrigatório desta sessão.")',
      '    return True',
      'cmd = (sys.argv[1] if len(sys.argv) > 1 else "check").lower()',
      'if cmd in ("start", "init"):',
      '    mins = float(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MIN',
      '    start_or_reset(mins, False); do_check()',
      'elif cmd == "reset":',
      '    mins = float(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MIN',
      '    start_or_reset(mins, False); do_check()',
      'elif cmd in ("pulse", "cycle", "wait"):',
      '    w_sec = min(22, max(3, int(float(sys.argv[2])) if len(sys.argv) > 2 else 18))',
      '    chat_bin = "/tmp/au_chat" if os.path.exists("/tmp/au_chat") else "/home/user/au_state/au_chat"',
      '    if os.path.exists(chat_bin):',
      '        subprocess.run(["python3", chat_bin, "wait", str(w_sec)], check=False)',
      '    else:',
      '        time.sleep(w_sec)',
      '    do_check()',
      'else:',
      '    do_check()',
      'EOF',
      'mkdir -p /home/user/au_state && cp -f /tmp/au_timer /home/user/au_state/au_timer && chmod +x /tmp/au_timer /home/user/au_state/au_timer',
      `/tmp/au_timer start ${targetMinutes}`,
      '```',
      hasChat
        ? `Comandos rápidos do Timer Real: \`/tmp/au_timer check\` (vê o relógio real na hora) | \`/tmp/au_timer pulse 18\` (escuta o \`/tmp/au_chat\` por até 18s e já mostra o relógio real atualizado!).`
        : `Comandos rápidos do Timer Real: \`/tmp/au_timer check\` (vê o relógio real na hora) | \`/tmp/au_timer pulse 18\` (pausa segura <22s + checagem do relógio real!).`
    ].join('\n');
  }

  function buildTempFileHubInstructions(tempFileConfig = {}) {
    if (tempFileConfig.enabled === false) return '';
    const binId = tempFileConfig.filebinId || 'arenaultra-shared';
    const expiry = tempFileConfig.litterboxExpiry || '24h';

    return [
      '',
      `📦 HUB DE ARQUIVOS TEMPORÁRIOS ENTRE AGENTS (Bucket da Sala: https://filebin.net/${binId}):`,
      'Instale `/tmp/au_upload` e `/tmp/au_download` (persistem entre chamadas bash!) para trocar `.zip`, módulos prontos ou builds com a equipe:',
      '```bash',
      'cat << \'EOF\' > /tmp/au_upload',
      '#!/usr/bin/env bash',
      'f="$1"; name="$(basename "$f")"; url=""',
      `if curl -fsS -m 20 -X POST -H "User-Agent: curl/8.5.0" -H "Content-Type: application/octet-stream" -H "cid: au" --data-binary @"$f" "https://filebin.net/${binId}/$name" >/dev/null 2>&1; then`,
      `  echo "[ARQUIVO_COMPARTILHADO] $name | Filebin.net | https://filebin.net/${binId}/$name [/ARQUIVO_COMPARTILHADO]"; exit 0; fi`,
      `url=$(curl -fsS -m 25 -F "reqtype=fileupload" -F "time=${expiry}" -F "fileToUpload=@$f" https://litterbox.catbox.moe/resources/internals/api.php 2>/dev/null || true)`,
      'if [[ "$url" == http* ]]; then echo "[ARQUIVO_COMPARTILHADO] $name | Litterbox | $url [/ARQUIVO_COMPARTILHADO]"; exit 0; fi',
      'url=$(curl -fsS -m 25 -F "files[]=@$f" https://uguu.se/upload 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[\x27files\x27][0][\x27url\x27])" 2>/dev/null || true)',
      'if [[ "$url" == http* ]]; then echo "[ARQUIVO_COMPARTILHADO] $name | Uguu.se | $url [/ARQUIVO_COMPARTILHADO]"; exit 0; fi',
      'url=$(curl -fsS -m 25 -F "file=@$f" https://x0.at/ 2>/dev/null | tr -d "\\r\\n" || true)',
      'if [[ "$url" == http* ]]; then echo "[ARQUIVO_COMPARTILHADO] $name | x0.at | $url [/ARQUIVO_COMPARTILHADO]"; exit 0; fi',
      'EOF',
      'cat << \'EOF\' > /tmp/au_download',
      '#!/usr/bin/env bash',
      'curl -fsSL -H "User-Agent: curl/8.5.0" -H "Cookie: verified=2024-05-24" "$1" -o "$2"',
      'EOF',
      'chmod +x /tmp/au_upload /tmp/au_download',
      '```',
      'Sempre que rodar `/tmp/au_upload arquivo.zip`, avise também via `/tmp/au_chat send "Subi arquivo.zip em ..."` e inclua a linha `[ARQUIVO_COMPARTILHADO] ... [/ARQUIVO_COMPARTILHADO]` na resposta!'
    ].join('\n');
  }

  function resolveGitRepoSpec(rawInput) {
    if (global.AU_INTEGRATIONS && typeof global.AU_INTEGRATIONS.parseGitRepoSpec === 'function') {
      return global.AU_INTEGRATIONS.parseGitRepoSpec(rawInput);
    }
    let raw = String(rawInput || '').trim();
    if (!raw) return null;
    raw = raw.replace(/^<+|>$/g, '').replace(/^["'`]+|["'`]+$/g, '').trim();
    const scp = raw.match(/^(?:ssh:\/\/)?git@([^:/\s]+)[:/](.+)$/i);
    let host = 'github.com';
    let pathPart = '';
    let embeddedToken = '';
    let branchFromUrl = '';
    if (scp) {
      host = String(scp[1] || 'github.com').toLowerCase().replace(/^www\./, '');
      pathPart = String(scp[2] || '').split(/[?#]/)[0];
    } else if (/^https?:\/\//i.test(raw) || /^(?:www\.)?github\.com\//i.test(raw)) {
      try {
        const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        host = String(u.hostname || 'github.com').toLowerCase().replace(/^www\./, '');
        const decPart = (s) => {
          try {
            return decodeURIComponent(String(s || ''));
          } catch (_) {
            return String(s || '');
          }
        };
        if (u.password) embeddedToken = decPart(u.password);
        else if (u.username && !/^(git|x-access-token|oauth2|token)$/i.test(decPart(u.username))) {
          embeddedToken = decPart(u.username);
        }
        pathPart = u.pathname || '';
      } catch (_) {
        pathPart = raw.replace(/^https?:\/\/[^/]+\//i, '');
      }
    } else {
      pathPart = raw.split(/[?#]/)[0];
    }
    function safeDecode(s) {
      try {
        return decodeURIComponent(String(s || ''));
      } catch (_) {
        return String(s || '');
      }
    }
    const segs = String(pathPart || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (segs.length < 2) return null;
    const owner = safeDecode(segs[0]);
    const repo = safeDecode(segs[1]).replace(/\.git$/i, '');
    if ((segs[2] === 'tree' || segs[2] === 'blob' || segs[2] === 'commits') && segs[3]) {
      branchFromUrl =
        segs[2] === 'tree' && segs.length >= 4
          ? segs.slice(3).map((s) => safeDecode(s)).join('/')
          : safeDecode(segs[3]);
    }
    const fullName = `${owner}/${repo}`;
    return {
      owner,
      repo,
      fullName,
      host,
      isGithub: host === 'github.com' || host.endsWith('.github.com'),
      webUrl: `https://${host}/${fullName}`,
      cloneUrl: `https://${host}/${fullName}.git`,
      branchFromUrl,
      embeddedToken
    };
  }

  function cleanTokenString(rawToken) {
    return String(rawToken || '')
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^(Bearer|token)\s+/i, '')
      .trim();
  }

  function buildAuGhPythonCliLines(spec, baseBranch, myBranch, vaultOpts = {}) {
    const safeRepo = JSON.stringify(spec.fullName);
    const safeClone = JSON.stringify(spec.cloneUrl);
    const safeBase = JSON.stringify(baseBranch);
    const safeMyBr = JSON.stringify(myBranch);
    const safeWikiClone = JSON.stringify(`https://${spec.host || 'github.com'}/${spec.fullName}.wiki.git`);
    const safeVaultMode = vaultOpts && vaultOpts.vaultMode ? 'True' : 'False';
    const safeVaultBin = JSON.stringify(String((vaultOpts && vaultOpts.filebinId) || ''));
    const safeVaultCap = JSON.stringify(String((vaultOpts && vaultOpts.vaultCap) || ''));
    const safeAccess = JSON.stringify(String((vaultOpts && vaultOpts.accessLevel) || 'push_and_pr'));
    const safeAgentSlot = JSON.stringify(String((vaultOpts && vaultOpts.agentSlot) || 'ag1'));

    return [
      "cat << 'EOF' > /tmp/au_gh",
      '#!/usr/bin/env python3',
      'import sys, os, json, time, random, base64, subprocess, urllib.request, urllib.error, urllib.parse',
      `REPO = ${safeRepo}`,
      `CLONE_URL = ${safeClone}`,
      `WIKI_URL = ${safeWikiClone}`,
      `BASE_BR = ${safeBase}`,
      `MY_BR = ${safeMyBr}`,
      `VAULT_MODE = ${safeVaultMode}`,
      `VAULT_BIN = ${safeVaultBin}`,
      `VAULT_CAP = ${safeVaultCap}`,
      `ACCESS_LEVEL = ${safeAccess}`,
      `AGENT_SLOT = ${safeAgentSlot}`,
      'WORKDIR = "/home/user/repo"',
      'ASKPASS = "/tmp/au_git_askpass.sh"',
      'def tok():',
      '    if VAULT_MODE: return ""',
      '    if os.path.exists(ASKPASS):',
      '        try:',
      '            t = subprocess.check_output([ASKPASS, "Password"], text=True).strip()',
      '            if t and t != "none": return t',
      '        except Exception: pass',
      '    return ""',
      'def vault_rpc(action, args=None, timeout_s=18):',
      '    if not VAULT_BIN or not VAULT_CAP: return None',
      '    rid = f"{int(time.time()*1000)}_{AGENT_SLOT}_{random.randint(1000,9999)}"',
      '    req_fn = f"auvault_req_{rid}.json"; res_fn = f"auvault_res_{rid}.json"',
      '    payload = json.dumps({"reqId": rid, "cap": VAULT_CAP, "slot": AGENT_SLOT, "repo": REPO, "action": action, "args": args or {}, "ts": int(time.time()*1000)}, ensure_ascii=False).encode("utf-8")',
      '    try:',
      '        rq = urllib.request.Request(f"https://filebin.net/{VAULT_BIN}/{req_fn}", data=payload, method="POST", headers={"User-Agent": "curl/8.5.0", "Content-Type": "application/json", "Accept": "application/json", "cid": "au-vault"})',
      '        with urllib.request.urlopen(rq, timeout=12) as r: r.read()',
      '    except Exception: return None',
      '    waited = 0.0',
      '    while waited < timeout_s:',
      '        time.sleep(1.5); waited += 1.5',
      '        try:',
      '            gq = urllib.request.Request(f"https://filebin.net/{VAULT_BIN}/{res_fn}", headers={"User-Agent": "curl/8.5.0", "Accept": "application/json", "Cookie": "verified=2024-05-24"})',
      '            with urllib.request.urlopen(gq, timeout=8) as gr: return json.loads(gr.read().decode("utf-8"))',
      '        except Exception: pass',
      '    return None',
      'def collect_repo_files(max_files=85, max_bytes=2200000):',
      '    import stat as _stat',
      '    out = []; total = 0',
      '    always_skip = {".git", "node_modules", "__pycache__", ".venv", "venv", ".arena"}',
      '    root_skip = {"dist", "build", "target", ".next", "out", "coverage"}',
      '    if not os.path.isdir(WORKDIR): return out',
      '    for root, dirs, files in os.walk(WORKDIR):',
      '        is_top = os.path.abspath(root) == os.path.abspath(WORKDIR)',
      '        dirs[:] = [d for d in dirs if d not in always_skip and not (is_top and d in root_skip)]',
      '        for fn in sorted(files):',
      '            full = os.path.join(root, fn)',
      '            rel = os.path.relpath(full, WORKDIR).replace("\\\\", "/")',
      '            try:',
      '                lst = os.lstat(full)',
      '                if _stat.S_ISLNK(lst.st_mode):',
      '                    link_target = os.readlink(full).encode("utf-8")',
      '                    out.append({"path": rel, "base64": base64.b64encode(link_target).decode("ascii"), "mode": "120000"})',
      '                    continue',
      '                sz = lst.st_size',
      '                if sz > 380000 or total + sz > max_bytes or len(out) >= max_files: continue',
      '                with open(full, "rb") as fh: raw = fh.read()',
      '                fmode = "100755" if (lst.st_mode & 0o111) else "100644"',
      '                out.append({"path": rel, "base64": base64.b64encode(raw).decode("ascii"), "mode": fmode})',
      '                total += sz',
      '            except Exception: pass',
      '    return out',
      'def api(ep, method="GET", body=None, use_auth=True):',
      '    t = tok() if use_auth else ""',
      '    if ep.startswith("http"): url = ep',
      '    elif ep.startswith("/repos/"): url = "https://api.github.com" + ep',
      '    elif not ep or ep == "/": url = f"https://api.github.com/repos/{REPO}"',
      '    else: url = f"https://api.github.com/repos/{REPO}" + (ep if ep.startswith("/") else "/" + ep)',
      '    h = {"User-Agent": "ArenaUltra-AgentCLI/3.4.0", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}',
      '    if t: h["Authorization"] = f"Bearer {t}"',
      '    data = None',
      '    if body is not None:',
      '        data = json.dumps(body, ensure_ascii=False).encode("utf-8")',
      '        h["Content-Type"] = "application/json"',
      '    req = urllib.request.Request(url, data=data, method=method, headers=h)',
      '    try:',
      '        with urllib.request.urlopen(req, timeout=25) as r:',
      '            raw = r.read().decode("utf-8", errors="replace")',
      '            return json.loads(raw) if raw.strip() else {}',
      '    except urllib.error.HTTPError as e:',
      '        if e.code == 401 and t and method == "GET" and use_auth:',
      '            return api(ep, method=method, body=body, use_auth=False)',
      '        msg = e.read().decode("utf-8", errors="replace")',
      '        raise RuntimeError(f"GitHub API HTTP {e.code} ({ep}): {msg}")',
      'def sh(cmd, cwd=WORKDIR, check=True):',
      '    return subprocess.run(cmd, shell=True, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=check)',
      'def real_base():',
      '    try:',
      '        if BASE_BR:',
      '            try:',
      '                api("/branches/" + urllib.parse.quote(BASE_BR, safe=""))',
      '                return BASE_BR',
      '            except Exception: pass',
      '        info = api("")',
      '        return info.get("default_branch") or BASE_BR or "main"',
      '    except Exception:',
      '        return BASE_BR or "main"',
      'def check_write_rbac(need_pr=False):',
      '    if ACCESS_LEVEL in ("revoked", "read_only"):',
      '        sys.exit(f"🔒 [RBAC CENTRAL]: Seu nível de acesso neste repositório é \'{ACCESS_LEVEL}\' (somente leitura/revogado). Escrita bloqueada.")',
      '    if need_pr and ACCESS_LEVEL == "push_branch":',
      '        return "branch_only"',
      '    return "full"',
      'cmd = sys.argv[1] if len(sys.argv) > 1 else "overview"',
      'if cmd in ("vault-status", "whoami", "help", "--help"):',
      '    print(json.dumps({"repo": REPO, "mode": "vault_broker_zero_token" if VAULT_MODE else "direct_agent_git", "rbac": ACCESS_LEVEL, "baseBranch": BASE_BR, "agentBranch": MY_BR, "vaultBrokerReady": bool(VAULT_MODE and VAULT_BIN and VAULT_CAP)}, ensure_ascii=False))',
      '    sys.exit(0)',
      'if cmd in ("overview", "status"):',
      '    try:',
      '        info = api("")',
      '    except Exception:',
      '        vr = vault_rpc("overview") if VAULT_MODE else None',
      '        if vr and vr.get("ok") and vr.get("data"):',
      '            d = vr["data"]; info = d.get("repo") or {}',
      '            print(f"🔐 [COFRE ZERO-TOKEN] REPO: {info.get(\'fullName\')} | Default: {info.get(\'defaultBranch\')} | Seu RBAC: {ACCESS_LEVEL}")',
      '            print("🌿 Branches:", ", ".join(b.get("name","") for b in (d.get("branches") or [])) or "nenhuma")',
      '            print("🔀 PRs Abertos:", ", ".join(f"#{p[\'number\']} {p[\'title\']}" for p in (d.get("pulls") or [])) or "nenhum")',
      '            sys.exit(0)',
      '        raise',
      '    try: prs = api("/pulls?state=open&per_page=15")',
      '    except Exception: prs = []',
      '    try: issues = [i for i in api("/issues?state=open&per_page=15") if "pull_request" not in i]',
      '    except Exception: issues = []',
      '    try: runs = (api("/actions/runs?per_page=6") or {}).get("workflow_runs") or []',
      '    except Exception: runs = []',
      '    try: commits = api("/commits?per_page=5")',
      '    except Exception: commits = []',
      '    try: branches = api("/branches?per_page=25")',
      '    except Exception: branches = []',
      '    perms = info.get("permissions") or {}',
      '    auth_badge = f"Cofre Zero-Token (RBAC={ACCESS_LEVEL})" if VAULT_MODE else str(bool(perms.get("push") or tok()))',
      '    print(f"🐙 REPO: {info.get(\'full_name\')} ({\'PRIVADO\' if info.get(\'private\') else \'PÚBLICO\'}) | Default: {info.get(\'default_branch\')} | Acesso: {auth_badge}")',
      '    print("🌿 Branches: " + (", ".join(b.get("name","") for b in branches) if isinstance(branches, list) and branches else "repositório vazio"))',
      '    print(f"🔀 Pull Requests Abertos ({len(prs)}): " + (", ".join(f"#{p[\'number\']} {p[\'title\']} [{p[\'head\'][\'ref\']}->{p[\'base\'][\'ref\']}]" for p in prs) or "nenhum"))',
      '    print(f"🐛 Issues Abertas ({len(issues)}): " + (", ".join(f"#{i[\'number\']} {i[\'title\']}" for i in issues) or "nenhuma"))',
      '    print(f"⚙️ Actions ({len(runs)} recentes): " + (", ".join(f"run#{r[\'id\']} {r.get(\'name\')}:{r.get(\'status\')}/{r.get(\'conclusion\')}" for r in runs) or "nenhuma"))',
      '    if isinstance(commits, list):',
      '        for c in commits[:5]: print(f"  commit {c[\'sha\'][:7]}: {c[\'commit\'][\'message\'].splitlines()[0]}")',
      'elif cmd in ("code", "tree", "files"):',
      '    sub = (sys.argv[2] if len(sys.argv) > 2 else "").strip("/")',
      '    ep = f"/contents/{urllib.parse.quote(sub)}" if sub else "/contents"',
      '    res = api(ep)',
      '    if isinstance(res, list):',
      '        for it in res: print(f"{it.get(\'type\'):4s}  {it.get(\'path\')} ({it.get(\'size\',0)} B)")',
      '    elif isinstance(res, dict) and res.get("content"):',
      '        print(base64.b64decode(res["content"]).decode("utf-8", errors="replace"))',
      '    else: print(json.dumps(res, indent=2, ensure_ascii=False))',
      'elif cmd == "branches":',
      '    try: brs = api("/branches?per_page=30")',
      '    except Exception:',
      '        vr = vault_rpc("branches") if VAULT_MODE else None',
      '        brs = (vr or {}).get("data") or []',
      '    for b in brs: print(f"branch {b.get(\'name\')} ({((b.get(\'commit\') or {}).get(\'sha\') or b.get(\'sha\') or \'\')[:7]})")',
      'elif cmd in ("prs", "pulls"):',
      '    st = sys.argv[2] if len(sys.argv) > 2 else "all"',
      '    try: plist = api(f"/pulls?state={st}&per_page=25")',
      '    except Exception:',
      '        vr = vault_rpc("prs", {"state": st}) if VAULT_MODE else None',
      '        plist = (vr or {}).get("data") or []',
      '    for p in plist:',
      '        hd = (p.get("head") or {}).get("ref") if isinstance(p.get("head"), dict) else p.get("head")',
      '        bs = (p.get("base") or {}).get("ref") if isinstance(p.get("base"), dict) else p.get("base")',
      '        url = p.get("html_url") or p.get("htmlUrl") or ""',
      '        print(f"PR #{p[\'number\']} [{p[\'state\']}] {p[\'title\']} ({hd} -> {bs}) {url}")',
      'elif cmd == "pr":',
      '    n = sys.argv[2]',
      '    try:',
      '        p = api(f"/pulls/{n}"); files = api(f"/pulls/{n}/files?per_page=50")',
      '    except Exception:',
      '        vr = vault_rpc("pr", {"number": int(n)}) if VAULT_MODE else None',
      '        if not vr or not vr.get("ok"): raise',
      '        p = vr["data"]["pr"]; files = vr["data"]["files"]',
      '    print(f"PR #{p[\'number\']} [{p[\'state\']}] {p[\'title\']}\\n{p.get(\'body\') or \'\'}")',
      '    for f in files: print(f"  {f[\'status\']}: {f[\'filename\']} (+{f[\'additions\']}/-{f[\'deletions\']})")',
      'elif cmd in ("pr-ship", "pr-create"):',
      '    rbac_mode = check_write_rbac(need_pr=True)',
      '    rb = real_base()',
      '    a2 = (sys.argv[2] if len(sys.argv) > 2 else "").strip()',
      '    if a2 and " " in a2:',
      '        br = MY_BR; cmsg = a2; title = a2',
      '        body = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else f"Pull Request criado automaticamente na branch `{br}` sem intervenção humana."',
      '    else:',
      '        br = a2 or MY_BR',
      '        cmsg = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else f"feat({br}): entrega autônoma via Arena Ultra"',
      '        title = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else cmsg',
      '        body = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else f"Pull Request criado automaticamente na branch `{br}` sem intervenção humana."',
      '    if not br or br == rb: br = f"au/pr-{int(time.time())}"',
      '    if os.path.isfile(body): body = open(body, "r", encoding="utf-8").read()',
      '    if VAULT_MODE:',
      '        files_payload = collect_repo_files()',
      '        act = "push_files" if rbac_mode == "branch_only" else "pr_ship"',
      '        vr = vault_rpc(act, {"branch": br, "baseBranch": rb, "message": cmsg, "prTitle": title, "prBody": body, "files": files_payload}, timeout_s=22) if files_payload else None',
      '        if vr and vr.get("ok"):',
      '            d = vr.get("data") or {}; pr_obj = d.get("pullRequest") or {}',
      '            if pr_obj.get("htmlUrl"):',
      '                print(f"✅ [COFRE ZERO-TOKEN] PR #{pr_obj.get(\'number\')} PUBLICADO SEM EXPOR CREDENCIAL: [GITHUB_PR_CRIADO] {pr_obj[\'htmlUrl\']} [/GITHUB_PR_CRIADO]")',
      '            else:',
      '                print(f"✅ [COFRE ZERO-TOKEN] Branch `{d.get(\'branch\', br)}` atualizada ({(d.get(\'commitSha\') or \'\')[:7]}) sem expor credencial!")',
      '            sys.exit(0)',
      '        elif vr and not vr.get("ok"):',
      '            sys.exit(f"🔒 [COFRE ZERO-TOKEN RECUSOU]: {vr.get(\'error\')}")',
      '        print(f"🔐 [COFRE ZERO-TOKEN • CAS EXPORT AGENDADO]: Alterações salvas em {WORKDIR} para a branch `{br}`.")',
      '        print(f"[GITHUB_PUSH_PRONTO] {cmsg} [/GITHUB_PUSH_PRONTO]")',
      '        sys.exit(0)',
      '    if not tok(): sys.exit("ERRO: Token PAT não configurado em /tmp/au_git_askpass.sh (ou ative o modo Cofre Zero-Token).")',
      '    sh(f"git checkout -B {json.dumps(br)}", check=False)',
      '    sh("git add -A")',
      '    st = sh("git status --porcelain", check=False).stdout.strip()',
      '    if st: sh(f"git commit -m {json.dumps(cmsg)}")',
      '    sh("git fetch origin", check=False)',
      '    sh(f"git pull --rebase origin {json.dumps(br)}", check=False)',
      '    p_res = sh(f"git push -u origin {json.dumps(br)}", check=False)',
      '    if p_res.returncode != 0: sys.exit(f"ERRO git push: {p_res.stderr}")',
      '    if rbac_mode == "branch_only":',
      '        print(f"✅ Branch `{br}` enviada (RBAC \'push_branch\': criação de PR reservada ao Líder Sintetizador).")',
      '        sys.exit(0)',
      '    owner = REPO.split("/")[0]',
      '    q = urllib.parse.urlencode({"state": "open", "head": f"{owner}:{br}", "base": rb})',
      '    ex = api(f"/pulls?{q}")',
      '    if isinstance(ex, list) and len(ex) > 0:',
      '        pr = api(f"/pulls/{ex[0][\'number\']}", method="PATCH", body={"title": title, "body": body})',
      '        print(f"✅ PR #{pr[\'number\']} ATUALIZADO: [GITHUB_PR_CRIADO] {pr[\'html_url\']} [/GITHUB_PR_CRIADO]")',
      '    else:',
      '        pr = api("/pulls", method="POST", body={"title": title, "head": br, "base": rb, "body": body})',
      '        print(f"✅ PR #{pr[\'number\']} CRIADO DIRETO: [GITHUB_PR_CRIADO] {pr[\'html_url\']} [/GITHUB_PR_CRIADO]")',
      'elif cmd == "pr-merge":',
      '    check_write_rbac(need_pr=True)',
      '    n = sys.argv[2]; m = sys.argv[3] if len(sys.argv) > 3 else "squash"',
      '    if VAULT_MODE:',
      '        vr = vault_rpc("pr_merge", {"number": int(n), "mergeMethod": m})',
      '        print("Merged via Cofre:" if (vr and vr.get("ok")) else f"Erro Cofre: {(vr or {}).get(\'error\')}", (vr or {}).get("data"))',
      '    else:',
      '        r = api(f"/pulls/{n}/merge", method="PUT", body={"merge_method": m})',
      '        print("Merged:", r)',
      'elif cmd in ("pr-comment", "issue-comment"):',
      '    check_write_rbac(need_pr=False)',
      '    n = sys.argv[2]; txt = " ".join(sys.argv[3:])',
      '    if VAULT_MODE:',
      '        vr = vault_rpc("pr_comment", {"number": int(n), "body": txt})',
      '        print("Commented via Cofre:", ((vr or {}).get("data") or {}).get("html_url") or vr)',
      '    else:',
      '        r = api(f"/issues/{n}/comments", method="POST", body={"body": txt})',
      '        print("Commented:", r.get("html_url"))',
      'elif cmd == "issues":',
      '    st = sys.argv[2] if len(sys.argv) > 2 else "open"',
      '    try: ilist = api(f"/issues?state={st}&per_page=30")',
      '    except Exception:',
      '        vr = vault_rpc("issues", {"state": st}) if VAULT_MODE else None',
      '        ilist = (vr or {}).get("data") or []',
      '    for i in ilist:',
      '        if "pull_request" not in i: print(f"Issue #{i[\'number\']} [{i[\'state\']}] {i[\'title\']} ({i[\'html_url\']})")',
      'elif cmd == "issue":',
      '    n = sys.argv[2]',
      '    try: i = api(f"/issues/{n}"); cs = api(f"/issues/{n}/comments")',
      '    except Exception:',
      '        vr = vault_rpc("issue", {"number": int(n)}) if VAULT_MODE else None',
      '        if not vr or not vr.get("ok"): raise',
      '        i = vr["data"]["issue"]; cs = vr["data"]["comments"]',
      '    print(f"Issue #{i[\'number\']} [{i[\'state\']}] {i[\'title\']}\\n{i.get(\'body\') or \'\'}")',
      '    for c in cs: print(f"  @{c[\'user\'][\'login\']}: {c.get(\'body\',\'\')}")',
      'elif cmd == "issue-new":',
      '    check_write_rbac(need_pr=False)',
      '    t_arg = sys.argv[2]; b_arg = sys.argv[3] if len(sys.argv) > 3 else ""',
      '    if VAULT_MODE:',
      '        vr = vault_rpc("issue_new", {"title": t_arg, "body": b_arg})',
      '        print("Issue criada via Cofre:", ((vr or {}).get("data") or {}).get("html_url") or vr)',
      '    else:',
      '        r = api("/issues", method="POST", body={"title": t_arg, "body": b_arg})',
      '        print("Issue criada:", r.get("html_url"))',
      'elif cmd == "actions":',
      '    try: runs = (api("/actions/runs?per_page=12") or {}).get("workflow_runs") or []',
      '    except Exception:',
      '        vr = vault_rpc("actions") if VAULT_MODE else None',
      '        runs = (vr or {}).get("data") or []',
      '    for r in runs: print(f"Run #{r[\'id\']} | {r.get(\'name\')} | branch={r.get(\'head_branch\')} | {r.get(\'status\')}/{r.get(\'conclusion\')} | {r.get(\'html_url\')}")',
      'elif cmd in ("action-run", "action-jobs"):',
      '    rid = sys.argv[2]',
      '    try: jobs = (api(f"/actions/runs/{rid}/jobs") or {}).get("jobs") or []',
      '    except Exception:',
      '        vr = vault_rpc("action_run", {"runId": rid}) if VAULT_MODE else None',
      '        jobs = (vr or {}).get("data") or []',
      '    for j in jobs:',
      '        print(f"Job {j[\'name\']} -> {j.get(\'status\')}/{j.get(\'conclusion\')}")',
      '        for s in (j.get("steps") or []):',
      '            if s.get("conclusion") not in ("success", "skipped", None): print(f"  ❌ Step {s[\'number\']}: {s[\'name\']} ({s.get(\'conclusion\')})")',
      'elif cmd == "releases":',
      '    for r in api("/releases?per_page=10"): print(f"Release {r.get(\'tag_name\')}: {r.get(\'name\')} ({r.get(\'html_url\')})")',
      'elif cmd == "projects":',
      '    try: ms = api("/milestones?state=all")',
      '    except Exception: ms = []',
      '    vr = vault_rpc("projects") if VAULT_MODE else None',
      '    if vr and vr.get("ok") and vr.get("data"):',
      '        pdata = vr["data"]; plist = pdata.get("projects") or []',
      '        print(f"Projects v2 GraphQL ({len(plist)}):", [f"#{p.get(\'number\')} {p.get(\'title\')} [{p.get(\'state\')}] {p.get(\'url\')}" for p in plist])',
      '        if pdata.get("note"): print("Nota Projects v2:", pdata.get("note"))',
      '    else:',
      '        print("Projects v2 GraphQL: requer Cofre autenticado com escopo read:project.")',
      '    print(f"Milestones ({len(ms)}):", [f"#{m[\'number\']} {m[\'title\']} ({m[\'open_issues\']} abertas)" for m in ms] if isinstance(ms, list) else [])',
      'elif cmd == "wiki":',
      '    subprocess.run(["rm", "-rf", "/home/user/repo-wiki"])',
      '    r = sh(f"git clone {json.dumps(WIKI_URL)} /home/user/repo-wiki", cwd="/home/user", check=False)',
      '    print("Wiki clonada em /home/user/repo-wiki!" if r.returncode == 0 else f"Wiki vazia ou desativada no repo: {r.stderr.strip()}")',
      'elif cmd in ("insights", "pulse"):',
      '    try: contribs = api("/contributors?per_page=15")',
      '    except Exception: contribs = []',
      '    try: tags = api("/tags?per_page=15")',
      '    except Exception: tags = []',
      '    c_str = ", ".join(f"{c[\'login\']}({c[\'contributions\']})" for c in contribs) if isinstance(contribs, list) and contribs else "nenhum/calculando"',
      '    t_str = ", ".join(t["name"] for t in tags) if isinstance(tags, list) and tags else "nenhuma"',
      '    print("Contribuidores:", c_str)',
      '    print("Tags:", t_str)',
      'else:',
      '    print(json.dumps(api(cmd), indent=2, ensure_ascii=False))',
      'EOF',
      'chmod 700 /tmp/au_gh'
    ];
  }

  function buildGithubInstructions(githubConfig, agentRole, roomId) {
    if (!githubConfig || !githubConfig.enabled || !githubConfig.repo) return '';
    const spec = resolveGitRepoSpec(githubConfig.repo);
    if (!spec) return '';

    // DATA-04: Honest non-GitHub Forge handling (GitLab, Bitbucket, Gitea)
    if (!spec.isGithub) {
      return [
        '',
        `🌐 REPOSITÓRIO GIT EXTERNO (${spec.host} • ${spec.webUrl}):`,
        `- Host \`${spec.host}\` detectado: o Cofre Broker API REST suporta exclusivamente \`github.com\`.`,
        `- Para inspecionar o código público, clone com \`git clone "${spec.cloneUrl}" /home/user/repo\` e compartilhe patches/artefatos com a equipe via \`/tmp/au_upload\` e \`[TEMPCHAT]\`.`
      ].join('\n');
    }

    const roleObj = agentRole || { shortTitle: 'agent', isSynthesizer: true };
    const accessLevel = resolveEffectiveAgentAccessLevel(roleObj, githubConfig);
    if (accessLevel === 'revoked') {
      return [
        '',
        `🔒 GESTÃO CENTRAL DE ACESSO GITHUB (${spec.webUrl}):`,
        '- Seu nível de acesso neste repositório foi definido como **REVOGADO** pelo Coordenador Central. Trabalhe apenas localmente e sincronize suas contribuições via `/tmp/au_chat` / `[TEMPCHAT]` para revisão do Líder Sintetizador.'
      ].join('\n');
    }

    const effectiveToken = cleanTokenString(githubConfig.token || spec.embeddedToken || '');
    const hasVaultToken = Boolean(effectiveToken || githubConfig.hasVaultCredential);
    const baseBranch = (githubConfig.baseBranch || spec.branchFromUrl || 'main').trim();
    // SEC-01: Legacy direct_agent_git is permanently retired and coerced to vault_broker_zero_token — ZERO PAT IN PROMPT!
    const authMode = githubConfig.authMode === 'extension_proxy_push' ? 'extension_proxy_push' : 'vault_broker_zero_token';
    const branchMode = githubConfig.branchMode || 'branch_per_agent_pr';
    const autoCreatePR = githubConfig.autoCreatePR !== false;
    const isSoloDirect = Boolean(githubConfig.soloDirect);
    const cleanRoomSlug = String(roomId || '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
    const soloPrBranch =
      !cleanRoomSlug || cleanRoomSlug === 'solo' || cleanRoomSlug === 'lote' || cleanRoomSlug === 'agent'
        ? 'au/pr-solo'
        : `au/pr-${cleanRoomSlug}`;
    const myBranch = githubConfig.explicitBranch
      ? String(githubConfig.explicitBranch).trim()
      : isSoloDirect
        ? autoCreatePR && branchMode !== 'single_shared_branch'
          ? soloPrBranch
          : baseBranch
        : computeAgentBranchName(roomId, roleObj, githubConfig);
    const repoSnapshotUrl = String(githubConfig.repoSnapshotUrl || '').trim();
    const mySlot = `ag${Number(roleObj.agentIndex || (Number(roleObj.index || 0) + 1))}`;
    const isVaultZeroToken = authMode === 'vault_broker_zero_token' && hasVaultToken;
    const auGhLines = buildAuGhPythonCliLines(spec, baseBranch, myBranch, {
      vaultMode: isVaultZeroToken || authMode === 'extension_proxy_push',
      filebinId: githubConfig.filebinId || '',
      vaultCap: githubConfig.agentVaultCap || '',
      accessLevel,
      agentSlot: mySlot
    });

    const rbacBadgeMap = {
      push_and_pr: 'Push + Pull Request (Autônomo)',
      push_branch: `Push apenas na branch \`${myBranch}\` (PR reservado ao Líder)`,
      read_only: 'Somente Leitura (QA / Revisor — escrita bloqueada)'
    };
    const rbacDesc = rbacBadgeMap[accessLevel] || accessLevel;

    const commonAccessRules = [
      '- PROIBIDO chamar `list_connector_tools("github")` ou pedir ao usuário para ativar conectores/apps — seu acesso já está pré-instalado abaixo!',
      `- PROIBIDO usar \`fetch_page\` em páginas HTML do GitHub (\`github.com/${spec.fullName}/issues\`, \`/pulls\`, \`/actions\`, \`/projects\`, \`/wiki\`, \`/pulse\`): use SEMPRE \`/tmp/au_gh\` no \`bash\` (\`/tmp/au_gh overview\`, \`/tmp/au_gh prs\`, \`/tmp/au_gh issues\`, \`/tmp/au_gh actions\`, \`/tmp/au_gh projects\`, \`/tmp/au_gh wiki\`, \`/tmp/au_gh insights\`) e \`/home/user/repo\`!`,
      `- Permissão Centralizada deste Agente (RBAC): **${rbacDesc}**.`
    ];

    // Case 0 (v4.0 MANDATORY ZERO-TOKEN VAULT): Token NEVER enters prompt or /tmp!
    if (isVaultZeroToken) {
      const repoInitLines = repoSnapshotUrl
        ? [
            'mkdir -p /tmp/au_repo_init /home/user/repo',
            `curl -fsSL -H "User-Agent: curl/8.5.0" "${repoSnapshotUrl}" -o /tmp/au_repo_init.zip`,
            'unzip -qo /tmp/au_repo_init.zip -d /tmp/au_repo_init',
            'TOP_DIR=$(find /tmp/au_repo_init -mindepth 1 -maxdepth 1 -type d | head -n 1)',
            'if [ -n "$TOP_DIR" ]; then cp -a "$TOP_DIR"/. /home/user/repo/; else cp -a /tmp/au_repo_init/. /home/user/repo/; fi'
          ]
        : [
            'if [ -d /home/user/repo ] && [ ! -d /home/user/repo/.git ]; then rm -rf /home/user/repo; fi',
            `if [ ! -d /home/user/repo/.git ]; then git clone "${spec.cloneUrl}" /home/user/repo 2>/dev/null || (mkdir -p /home/user/repo && cd /home/user/repo && git init -b "${myBranch}"); fi`,
            `cd /home/user/repo && (git checkout "${myBranch}" 2>/dev/null || git checkout -b "${myBranch}" 2>/dev/null || true)`
          ];

      const writeInstruction =
        accessLevel === 'read_only'
          ? '- MODO SOMENTE LEITURA (RBAC): audite o código em `/home/user/repo`, consulte PRs/Issues/Actions via `/tmp/au_gh` e publique seu parecer técnico no `/tmp/au_chat` e `[TEMPCHAT]`.'
          : accessLevel === 'push_branch'
            ? `- ENTREGA NA BRANCH DEDICADA SEM TOKEN NO PROMPT (\`${myBranch}\`): ao concluir e testar em \`/home/user/repo\`, execute \`/tmp/au_gh pr-ship "${myBranch}" "feat(${roleObj.shortTitle || 'agent'}): resumo"\` (e inclua \`[GITHUB_PUSH_PRONTO] feat: resumo [/GITHUB_PUSH_PRONTO]\` na resposta) — o Cofre da Extensão publicará sua branch via CAS completo sem expor credenciais!`
            : `- AUTONOMIA DE PULL REQUEST VIA COFRE ZERO-TOKEN (\`${myBranch}\` -> \`${baseBranch}\`): NUNCA peça confirmação humana! Ao validar suas alterações em \`/home/user/repo\`, publique Commit + Pull Request em **1 comando**:\n  \`/tmp/au_gh pr-ship "${myBranch}" "feat(${roleObj.shortTitle || 'agent'}): resumo" "🚀 Entrega Técnica" "Resumo das mudanças e testes"\`\n  (e inclua também \`[GITHUB_PUSH_PRONTO] feat(${roleObj.shortTitle || 'agent'}): resumo [/GITHUB_PUSH_PRONTO]\` na sua resposta para exportação CAS direta!).`;

      return [
        '',
        `🔐 COFRE DE CREDENCIAIS GIT ZERO-TOKEN NO PROMPT (Repositório: ${spec.webUrl} • Branch: \`${myBranch}\` • Base: \`${baseBranch}\`):`,
        '- SEGURANÇA MÁXIMA (SEC-01): O Token GitHub permanece **100% selado na memória volátil da extensão** (zero credencial exposta neste prompt ou em `/tmp`!). O Cofre executa pushes/PRs autenticados via CAS e valida seu RBAC centralmente.',
        ...commonAccessRules,
        'Execute no seu **1º comando bash** para instalar `/tmp/au_gh` conectado ao Cofre e preparar `/home/user/repo`:',
        '```bash',
        'git config --global --unset core.askPass 2>/dev/null || true',
        'git config --global credential.interactive never',
        ...auGhLines,
        ...repoInitLines,
        '/tmp/au_gh overview || true',
        'ls -la /home/user/repo',
        '```',
        writeInstruction
      ].join('\n');
    }

    // Case 1: Public ("normal") repository WITHOUT token (and not extension_proxy_push with snapshot)
    if (!hasVaultToken && !repoSnapshotUrl && authMode !== 'extension_proxy_push') {
      return [
        '',
        `🐙 INTEGRAÇÃO GITHUB PÚBLICA NO TERMINAL (Repositório: ${spec.webUrl} • Branch alvo: ${baseBranch}):`,
        ...commonAccessRules,
        'Execute agora no seu **1º comando bash** para instalar `/tmp/au_gh`, clonar o código em `/home/user/repo` e ler Code + Issues + PRs + Actions + Insights de uma vez:',
        '```bash',
        'git config --global --unset core.askPass 2>/dev/null || true',
        'git config --global credential.interactive never',
        'git config --global user.name "Arena Ultra Agent"',
        'git config --global user.email "agent@arena-ultra.local"',
        ...auGhLines,
        'if [ -d /home/user/repo ] && [ ! -d /home/user/repo/.git ]; then rm -rf /home/user/repo; fi',
        `if [ ! -d /home/user/repo/.git ]; then git clone "${spec.cloneUrl}" /home/user/repo; fi`,
        'cd /home/user/repo && git fetch origin 2>/dev/null || true',
        'DEF_BR=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/origin/@@" || true)',
        `BASE_BR="${baseBranch}"`,
        'if ! git show-ref --verify --quiet "refs/remotes/origin/$BASE_BR" && [ -n "$DEF_BR" ]; then BASE_BR="$DEF_BR"; fi',
        `git checkout "${myBranch}" 2>/dev/null || git checkout -b "${myBranch}" "origin/$BASE_BR" 2>/dev/null || git checkout -b "${myBranch}"`,
        '/tmp/au_gh overview',
        'ls -la /home/user/repo',
        '```',
        '- Trabalhe diretamente dentro de `/home/user/repo` e consulte Issues/PRs/Actions com `/tmp/au_gh issues`, `/tmp/au_gh prs`, `/tmp/au_gh actions`, `/tmp/au_gh wiki` (para publicar via extensão, emita `[GITHUB_PUSH_PRONTO] mensagem [/GITHUB_PUSH_PRONTO]`).'
      ].join('\n');
    }

    // Case 2: Extension CAS Proxy Push Mode (Browser exports Workspace CAS directly -> GitHub API, zero public host for private repos!)
    const bootstrapLines = repoSnapshotUrl
      ? [
          'Execute no seu **1º comando bash** para instalar `/tmp/au_gh` e descompactar a cópia em `/home/user/repo`:',
          '```bash',
          ...auGhLines,
          'mkdir -p /tmp/au_repo_init /home/user/repo',
          `curl -fsSL -H "User-Agent: curl/8.5.0" "${repoSnapshotUrl}" -o /tmp/au_repo_init.zip`,
          'unzip -qo /tmp/au_repo_init.zip -d /tmp/au_repo_init',
          'TOP_DIR=$(find /tmp/au_repo_init -mindepth 1 -maxdepth 1 -type d | head -n 1)',
          'if [ -n "$TOP_DIR" ]; then cp -a "$TOP_DIR"/. /home/user/repo/; else cp -a /tmp/au_repo_init/. /home/user/repo/; fi',
          '/tmp/au_gh overview || true',
          'ls -la /home/user/repo',
          '```'
        ]
      : [
          'Execute no seu **1º comando bash** para instalar `/tmp/au_gh` e preparar `/home/user/repo`:',
          '```bash',
          'git config --global --unset core.askPass 2>/dev/null || true',
          ...auGhLines,
          'if [ -d /home/user/repo ] && [ ! -d /home/user/repo/.git ]; then rm -rf /home/user/repo; fi',
          `if [ ! -d /home/user/repo/.git ]; then git clone "${spec.cloneUrl}" /home/user/repo 2>/dev/null || (mkdir -p /home/user/repo && cd /home/user/repo && git init -b "${myBranch}"); fi`,
          '/tmp/au_gh overview || true',
          'cd /home/user/repo && ls -la',
          '```'
        ];

    return [
      '',
      `🛡️ INTEGRAÇÃO GITHUB ATIVA (MODO PROXY CAS DIRETO VIA EXTENSÃO — Repositório: ${spec.webUrl}):`,
      ...commonAccessRules,
      `- Branch PR atribuída a você: \`${myBranch}\` (Base: \`${baseBranch}\`).`,
      '- MODO ZERO-HUMANO-NO-LOOP & ZERO-TOKEN: NUNCA peça confirmação ao usuário para commitar ou abrir Pull Request!',
      ...bootstrapLines,
      accessLevel === 'read_only'
        ? '- Seu RBAC atual é `read_only`: revise o código e reporte no TempChat sem solicitar push.'
        : `- Assim que concluir sua implementação em \`/home/user/repo\`, escreva na sua resposta:\n  \`[GITHUB_PUSH_PRONTO] feat(${roleObj.shortTitle || 'agent'}): descrição clara do commit e PR [/GITHUB_PUSH_PRONTO]\`\n  (a extensão exporta automaticamente o Workspace CAS direto do navegador e publica na API do GitHub sem expor código privado a terceiros!).`
    ].join('\n');
  }

  function buildUnifiedTeamPactSection(rolesList, myIdx) {
    const total = Array.isArray(rolesList) ? rolesList.length : 1;
    if (total <= 1) return '';
    return [
      `🤝 PACTO DE TIME UNIDO — ZERO COMPETIÇÃO (${total} AGENTES TRABALHANDO JUNTOS NO MESMO PROJETO):`,
      `- **VOCÊS NÃO SÃO COMPETIDORES DO MODO BATTLE!** Vocês são **UM ÚNICO TIME UNIDO de ${total} especialistas** dividindo um mesmo projeto.`,
      `- **REGRA DE OURO (ANTI-RETRABALHO)**: É **ESTRITAMENTE PROIBIDO** tentar construir o projeto inteiro sozinho ou reescrever arquivos assumidos por outro colega! Fazer o escopo de outro colega gera conflito e desperdiça o potencial da equipe.`,
      `- **CONVERSA & AUTO-ORGANIZAÇÃO OBRIGATÓRIA**: Conversem de verdade entre si usando \`@Agente1\`..\`@Agente${total}\` e \`@Todos\`! Discutam decisões técnicas, perguntem quando houver dúvida de interface, respondam nominalmente aos colegas e respeitem a divisão de arquivos do Quadro Único.`
    ].join('\n');
  }

  function sanitizeConciseTeamMessage(rawText, maxChars = 850) {
    let txt = String(rawText || '').replace(/\[(?:HARNESS_REPORT|AU_AGENT_READY)\][\s\S]*?\[\/(?:HARNESS_REPORT|AU_AGENT_READY)\]/g, '').trim();
    if (!txt) return '';
    // Replace large fenced code blocks so raw source files never flood or pollute the team chat!
    txt = txt.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (full, lang, body) => {
      const cleanBody = String(body || '').trim();
      const lineCount = cleanBody ? cleanBody.split('\n').length : 0;
      if (lineCount <= 6 && cleanBody.length <= 280) {
        return full;
      }
      const tagLang = lang ? ` (${lang}, ${lineCount} linhas)` : ` (${lineCount} linhas)`;
      return `[📄 trecho de código${tagLang} salvo no workspace/branch — veja arquivos no Quadro Único]`;
    });
    // Strip repetitive terminal prompts / progress bars
    txt = txt
      .replace(/(?:^|\n)\s*(?:\$\s+|root@[^\s]+:#\s+|npm warn [^\n]+|added \d+ packages[^\n]*)/gi, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (txt.length <= maxChars) return txt;
    const sliced = txt.slice(0, maxChars - 1);
    const lastBreak = Math.max(sliced.lastIndexOf('\n'), sliced.lastIndexOf('. '));
    return (lastBreak > Math.floor(maxChars * 0.55) ? sliced.slice(0, lastBreak + 1) : sliced).trim() + ' …';
  }

  // Bracket syntax handles spaces and model names without ambiguous substring matches.
  function isAgentMentioned(text, index, name, title) {
    const body = String(text || '').normalize('NFKC').toLocaleLowerCase();
    const aliases = [name, title, `Agente${index}`, `Agente ${index}`, `ag${index}`]
      .filter(Boolean).map(v => String(v).normalize('NFKC').trim().toLocaleLowerCase());
    for (const match of body.matchAll(/@\[([^\]\n]{1,160})\]/g)) {
      if (aliases.includes(match[1].trim())) return true;
    }
    if (/@(?:todos|all|equipe|time)\b/i.test(body)) return true;
    for (const alias of aliases) {
      let at = body.indexOf('@' + alias);
      while (at >= 0) {
        const after = body[at + alias.length + 1] || '';
        if (!/[\p{L}\p{N}_]/u.test(after)) return true;
        at = body.indexOf('@' + alias, at + 1);
      }
    }
    return false;
  }

  function extractDirectMentionsForAgent(peerMsgs, myIdx, myName, myTitle) {
    if (!Array.isArray(peerMsgs) || peerMsgs.length === 0) return [];
    const idxNum = Number(myIdx || 1);
    const handleRx = new RegExp(
      `(?:@\\s*agente\\s*0*${idxNum}\\b|\\bagente\\s*0*${idxNum}\\b|@\\s*ag0*${idxNum}\\b|@\\s*(?:todos|equipe|time|all)\\b)`,
      'i'
    );
    const roleKeywords = String(`${myName || ''} ${myTitle || ''}`)
      .toLowerCase()
      .match(/\b(?:arquiteto|core|frontend|interface|dados|api|seguranca|qa|auditor|integrador|sintetizador|lider|mediador)\b/g);
    const roleKeywordRx =
      roleKeywords && roleKeywords.length > 0
        ? new RegExp(`@\\s*(?:${Array.from(new Set(roleKeywords)).join('|')})\\b`, 'i')
        : null;

    const hits = [];
    for (const m of peerMsgs) {
      const rawBody = String(m.text || m.fullExcerpt || m.summary || '').trim();
      if (!rawBody) continue;
      const cleanBody = sanitizeConciseTeamMessage(rawBody, 460);
      const mentionsMe = isAgentMentioned(rawBody, idxNum, myName, myTitle) || handleRx.test(rawBody) || (roleKeywordRx ? roleKeywordRx.test(rawBody) : false);
      const hasQuestionOrProposal =
        /\?/.test(rawBody) ||
        /\b(?:proponho|concordam|o que acham|pode assumir|vamos alinhar|preciso confirmar|algu[eé]m tem depend[eê]ncia)\b/i.test(rawBody);
      if (mentionsMe || hasQuestionOrProposal) {
        hits.push({
          senderName: m.senderName || 'Colega',
          senderRole: m.senderRole || '',
          directMention: mentionsMe,
          excerpt: cleanBody
        });
      }
    }
    return hits;
  }

  function buildInitialAgentPrompt(params = {}) {
    if (params.agentKitEnabled && global.AU_AGENT_KIT) return global.AU_AGENT_KIT.initial(params);
    const roomId = params.roomId || '0000';
    const externalCode = params.externalCode || '';
    const profile = params.profile || 'specialists';
    const stopMode = params.stopMode || 'smart_consensus';
    const agentRole = params.agentRole || makeRole(0, 'Agente 1', 'Especialista', '', false);
    const rolesList = params.teamRoles || params.allRoles || [agentRole];
    const objective = params.basePrompt || params.baseObjective || '';
    const specificTask = params.specificTask || '';
    const isUniteOpenTabs = Boolean(params.uniteOpenTabs);

    const myName = agentRole.shortTitle || agentRole.agentName || 'Agente';
    const myIdx = agentRole.agentIndex || (Number(agentRole.index || 0) + 1);
    const myHandle = `@Agente${myIdx}`;
    const isSynth = Boolean(agentRole.isSynthesizer || agentRole.isLeader);

    const rosterLines = rolesList
      .map((r, idx) => {
        const rName = r.shortTitle || r.agentName || `Agente ${idx + 1}`;
        const rBrief = r.exclusiveScopeHint || r.roleDesc || r.roleBrief || r.roleTitle || '';
        const rIdx = r.agentIndex || idx + 1;
        return `  - [@Agente${rIdx}] ${rName}: ${rBrief}${rIdx === myIdx ? '  <-- [VOCÊ]' : ''}`;
      })
      .join('\n');

    const roomBadge = externalCode
      ? `SALA TEMPCHAT #${roomId} (Espelhada em tempchat.online #${externalCode})`
      : `SALA TEMPCHAT #${roomId}`;

    const profileLabel =
      (global.AU_DEFAULTS &&
        global.AU_DEFAULTS.COLLAB_PROFILES &&
        global.AU_DEFAULTS.COLLAB_PROFILES[profile] &&
        (global.AU_DEFAULTS.COLLAB_PROFILES[profile].label || global.AU_DEFAULTS.COLLAB_PROFILES[profile].name)) ||
      profile;

    const taskBlock =
      specificTask && specificTask !== objective
        ? `OBJETIVO GERAL DA EQUIPE:\n${objective}\n\nSUA FRENTE ESPECÍFICA INICIAL:\n${specificTask}`
        : `OBJETIVO DA EQUIPE:\n${objective}`;

    const fileHubBlock = buildTempFileHubInstructions(params.tempFileConfig || { enabled: false });
    const githubBlock = buildGithubInstructions(params.githubConfig || null, agentRole, roomId);

    const effectiveFilebinId =
      params.filebinId || (params.tempFileConfig && params.tempFileConfig.filebinId) || '';
    const realtimeChatBlock = effectiveFilebinId
      ? buildRealtimeChatInstructions({
          roomId,
          filebinId: effectiveFilebinId,
          roomHmacKey: params.roomHmacKey || '',
          minTimestampMs: Number(params.minTimestampMs || 0),
          lastSeenSeq: Number(params.lastSeenSeq || 0),
          agentIndex: myIdx,
          agentName: myName,
          roleTitle: agentRole.roleTitle
        })
      : '';

    const tplVer =
      (global.AU_DEFAULTS && global.AU_DEFAULTS.PROMPT_TEMPLATE_VERSION) || '4.0.0';
    const teamPact = buildUnifiedTeamPactSection(rolesList, myIdx);

    const headerLine = isUniteOpenTabs
      ? `🤝 [CONECTADO EM TEMPO REAL À ${roomBadge} • MODO COLABORAÇÃO MULTI-AGENT EM TEMPO REAL • Template v${tplVer}]`
      : `🤝 [${roomBadge} • MODO COLABORAÇÃO MULTI-AGENT EM TEMPO REAL • Template v${tplVer}]`;

    const parts = [
      headerLine,
      `Dinâmica da Sala: ${profileLabel}`,
      `Sua Identidade na Sala: ${myHandle} — ${myName} (${agentRole.roleTitle})`,
      ...(teamPact ? ['', teamPact] : []),
      '',
      `EQUIPE CONECTADA NESTA SALA TEMPCHAT AGORA (${rolesList.length} agente(s)):`,
      rosterLines,
      '',
      taskBlock
    ];

    // PROD-04: Inject shared Codebase Briefing & Architectural Decisions Log when cached
    if (params.codebaseBriefing && String(params.codebaseBriefing).trim()) {
      parts.push(
        '',
        '🧠 MEMÓRIA COMPARTILHADA DO PROJETO / BRIEFING INCREMENTAL:',
        String(params.codebaseBriefing).trim().slice(0, 3200)
      );
    }

    if (params.sharedBoard) {
      const boardSec = formatSharedBoardSection(params.sharedBoard, params.integrationStatus || null);
      if (boardSec) parts.push('', boardSec);
    }

    parts.push(buildSessionTimerInstructions({ sessionTimerMinutes: params.sessionTimerMinutes, agentIndex: myIdx, roomId, hasChat: Boolean(effectiveFilebinId) }));
    parts.push('O timer nunca supera PARAR, limites de créditos/tokens, segurança ou bloqueios humanos. Não gere trabalho artificial só para preencher tempo. Apenas o primeiro prompt contém este guia completo.');
    if (global.AU_HARNESS && params.harnessEnabled !== false) parts.push(global.AU_HARNESS.bootstrap({ roomId, agentIndex: myIdx, mode: profile, epoch: params.bindingEpoch || 1 }));
    if (realtimeChatBlock) parts.push(realtimeChatBlock);
    if (githubBlock) parts.push(githubBlock);
    if (fileHubBlock) parts.push(fileHubBlock);

    if (rolesList.length >= 2) {
      parts.push(
        '',
        `FASE 1 — RODA DE ALINHAMENTO, CONVERSA & DIVISÃO DE PAPÉIS (RODADA 1 DE ${rolesList.length} AGENTES):`,
        `1. **CONVERSE E DIVIDA ANTES DE CODAR PESADO**: No seu **1º comando \`bash\`**, instale \`/tmp/au_chat\`, rode \`/tmp/au_chat sync\` para ver o que os colegas já disseram, reivindique seus arquivos exclusivos com \`/tmp/au_chat claim "<sua_pasta_ou_arquivos>" "Escopo de ${myName}"\`, envie uma proposta/pergunta direta aos seus colegas (\`/tmp/au_chat send "@Todos Sou ${myHandle} (${agentRole.roleTitle}). Assumo [meus arquivos]. @Agente1/@Agente2 vamos confirmar os contratos de integração?"\`) e rode \`/tmp/au_chat wait 18\` para ler e responder ao vivo!`,
        '2. **DISCIPLINA DE TIME UNIDO NESTA RODADA 1**: Durante o ciclo do timer, implemente e valide sua frente, converse ao vivo sem encerrar só para esperar a próxima rodada. Estruture os contratos compartilhados (`/tmp/au_chat contract "<chave>" "<schema/interface>" congelado`) e construa **SOMENTE a fundação inicial da SUA frente exclusiva** — NUNCA crie arquivos pertencentes à frente dos outros colegas nem tente entregar o sistema completo sozinho na Rodada 1!',
        '3. **MENSAGEM LIMPA E DIRETA PARA O TIME (`[TEMPCHAT]...[/TEMPCHAT]`)**: Ao final da sua resposta, escreva um bloco `[TEMPCHAT]...[/TEMPCHAT]` **curto, claro e sem despejar código gigante** (máx ~12 linhas) contendo:',
        `   - **Meu Papel & Arquivos Exclusivos (${myHandle}):** quais arquivos/pastas você assumiu;`,
        '   - **Contratos / Acordos Técnicos:** rotas, funções ou formatos que os colegas devem usar;',
        '   - **Diálogo Direto com `@Colegas`:** perguntas ou confirmações nominais (`@Agente1`, `@Agente2`, ...) para alinhar a Rodada 2!',
        `4. ${buildStopRuleInstruction(stopMode, isSynth)}`
      );
    } else {
      parts.push(
        '',
        'REGRAS DE EXECUÇÃO NESTA RODADA:',
        '1. Instale `/tmp/au_chat` no 1º comando bash se disponível e envolva seu resumo final com `[TEMPCHAT]...[/TEMPCHAT]`.',
        `2. ${buildStopRuleInstruction(stopMode, isSynth)}`
      );
    }

    // SEC-01 Defense-in-depth: scrub any secret pattern before prompt leaves collab-engine
    const explicitTok = params.githubConfig && params.githubConfig.token ? params.githubConfig.token : '';
    return scrubIfPossible(parts.join('\n'), explicitTok);
  }

  function extractSharedFilesAndGitEvents(rawReply) {
    const text = String(rawReply || '').replace(/\[(?:HARNESS_REPORT|AU_AGENT_READY)\][\s\S]*?\[\/(?:HARNESS_REPORT|AU_AGENT_READY)\]/g, '');
    const sharedFiles = [];
    const seenUrls = new Set();

    // 1. Explicit [ARQUIVO_COMPARTILHADO] name | provider | url [/ARQUIVO_COMPARTILHADO]
    const tagRx = /\[ARQUIVO_COMPARTILHADO\]([\s\S]*?)\[\/ARQUIVO_COMPARTILHADO\]/gi;
    let m;
    while ((m = tagRx.exec(text)) !== null) {
      const inner = (m[1] || '').trim();
      const parts = inner.split('|').map((s) => s.trim());
      const urlCandidate = parts.find((p) => /^https?:\/\/\S+/i.test(p)) || '';
      if (urlCandidate && !seenUrls.has(urlCandidate)) {
        seenUrls.add(urlCandidate);
        const filename = parts[0] && !parts[0].startsWith('http') ? parts[0] : urlCandidate.split('/').pop() || 'arquivo';
        const provider = parts.length >= 3 ? parts[1] : 'TempHost';
        sharedFiles.push({
          filename,
          provider,
          url: urlCandidate
        });
      }
    }

    // 2. Auto-detect direct URLs from Filebin, Litterbox/Catbox, Uguu.se, x0.at
    const urlRx =
      /https?:\/\/(?:filebin\.net\/[A-Za-z0-9._-]+\/[A-Za-z0-9._%-]+|litter\.catbox\.moe\/[A-Za-z0-9._%-]+|[A-Za-z0-9.-]*uguu\.se\/[A-Za-z0-9._/%-]+|x0\.at\/[A-Za-z0-9._%-]+)/gi;
    let um;
    while ((um = urlRx.exec(text)) !== null) {
      const cleanUrl = um[0].replace(/[),.;'`"]+$/, '');
      if (!seenUrls.has(cleanUrl)) {
        seenUrls.add(cleanUrl);
        let provider = 'TempHost';
        if (/filebin\.net/i.test(cleanUrl)) provider = 'Filebin.net';
        else if (/catbox\.moe/i.test(cleanUrl)) provider = 'Litterbox';
        else if (/uguu\.se/i.test(cleanUrl)) provider = 'Uguu.se';
        else if (/x0\.at/i.test(cleanUrl)) provider = 'x0.at';
        let rawTail = cleanUrl.split('/').pop() || 'arquivo';
        try {
          rawTail = decodeURIComponent(rawTail);
        } catch (_) {}
        sharedFiles.push({
          filename: rawTail,
          provider,
          url: cleanUrl
        });
      }
    }

    // 3. Extract [GITHUB_PUSH_PRONTO] commit message [/GITHUB_PUSH_PRONTO]
    const pushMatch = text.match(/\[GITHUB_PUSH_PRONTO\]([\s\S]*?)\[\/GITHUB_PUSH_PRONTO\]/i);
    const githubPushReadyMessage = pushMatch && pushMatch[1] ? pushMatch[1].trim() : '';

    // 4. Detect GitHub PR / Commit / Branch URLs mentioned by Agents
    const ghUrls = [];
    const ghRx =
      /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull\/\d+|commit\/[0-9a-f]{7,40}|tree\/[^\s)<>"'`\]]+)/gi;
    let gm;
    while ((gm = ghRx.exec(text)) !== null) {
      const u = gm[0].replace(/[)\],.;'`"]+$/, '');
      if (!ghUrls.includes(u)) ghUrls.push(u);
    }

    // 5. ARENA-12: Extract verifiable convergence vote ([VOTO_CONSENSO: APROVAR] | [VOTO_CONSENSO: REJEITAR: motivo])
    let consensusVote = null;
    const voteMatch = text.match(/\[VOTO_CONSENSO\s*:\s*(APROVAR|ACEITAR|APPROVE|REJEITAR|REJECT)(?:\s*:\s*([^\]]*))?\]/i);
    if (voteMatch) {
      const rawVerb = String(voteMatch[1] || '').toUpperCase();
      consensusVote = {
        decision: rawVerb === 'REJEITAR' || rawVerb === 'REJECT' ? 'reject' : 'accept',
        reason: String(voteMatch[2] || '').trim().slice(0, 220)
      };
    } else if (/\[MODULO_PRONTO_INTEGRACAO\]|\[ENTREGA_FINAL_PRONTA\]/i.test(text)) {
      consensusVote = { decision: 'accept', reason: 'Módulo marcado pronto para integração' };
    }

    return {
      sharedFiles,
      githubPushReadyMessage,
      githubUrls: ghUrls,
      consensusVote
    };
  }

  // ARENA-12: Compute Verifiable Consensus vs Majority Acceptance Matrix
  function computeRoomConsensusMatrix(room) {
    const r = room || {};
    const agents = Array.isArray(r.agents) ? r.agents : [];
    const boardAssigns = (r.sharedBoard && r.sharedBoard.assignments) || {};
    const storedVotes = (r.consensusVotes && typeof r.consensusVotes === 'object') ? r.consensusVotes : {};
    const totalExpected = Math.max(1, Number(r.expectedAgents || agents.length || Object.keys(boardAssigns).length || 1));

    const matrix = [];
    let acceptedCount = 0;
    let rejectedCount = 0;
    for (let i = 0; i < totalExpected; i++) {
      const slotKey = `ag${i + 1}`;
      const ag = agents[i] || {};
      const assign = boardAssigns[slotKey] || {};
      const voteRec = storedVotes[slotKey] || null;
      let decision = voteRec ? voteRec.decision : 'pending';
      let reason = voteRec ? voteRec.reason : '';
      if (decision === 'pending' && (assign.status === 'pronto_integracao' || assign.status === 'concluido')) {
        decision = 'accept';
        reason = assign.notes || 'Pronto no Quadro Único';
      }
      if (decision === 'accept') acceptedCount++;
      else if (decision === 'reject') rejectedCount++;

      matrix.push({
        slotKey,
        agentName: ag.shortTitle || assign.agentName || `Agente ${i + 1}`,
        decision,
        reason
      });
    }

    const pendingCount = Math.max(0, totalExpected - acceptedCount - rejectedCount);
    let resolutionType = 'pending';
    let label = `⏳ Convergência em andamento (${acceptedCount}/${totalExpected})`;
    if (acceptedCount >= totalExpected && rejectedCount === 0) {
      resolutionType = 'consensus';
      label = `✅ Consenso Verificado (${acceptedCount}/${totalExpected})`;
    } else if (acceptedCount > totalExpected / 2) {
      resolutionType = 'majority';
      label = `⚖️ Decisão por Maioria (${acceptedCount}/${totalExpected}${rejectedCount ? ` • ${rejectedCount} objeção` : ''})`;
    } else if (rejectedCount > 0) {
      resolutionType = 'contested';
      label = `⚠️ Divergência Técnica (${rejectedCount} objeção, ${acceptedCount} a favor)`;
    }

    return {
      totalExpected,
      acceptedCount,
      rejectedCount,
      pendingCount,
      resolutionType,
      isUnanimousConsensus: resolutionType === 'consensus',
      isMajorityApproved: resolutionType === 'consensus' || resolutionType === 'majority',
      label,
      matrix
    };
  }

  function isSystemPromptLike(text) {
    if (global.AU_DEFAULTS && typeof global.AU_DEFAULTS.isSystemOrAutoPromptText === 'function') {
      return global.AU_DEFAULTS.isSystemOrAutoPromptText(text);
    }
    return /(?:🤝\s*\[?\s*SALA TEMPCHAT\s*#\d+|MODO COLABORAÇÃO MULTI-AGENT|SINCRONIZAÇÃO EM TEMPO REAL\s*•\s*RODADA|SUA MISSÃO AGORA NESTA RODADA\s*:)/i.test(
      String(text || '')
    );
  }

  function extractTempChatShare(rawReply, explicitToken, meta = {}) {
    // ARENA-02: Scrub serialized <details> / <thought> reasoning blocks BEFORE extracting share text!
    const reasoningScrubbed =
      global.AU_INTEGRATIONS && typeof global.AU_INTEGRATIONS.scrubReasoningBlocks === 'function'
        ? global.AU_INTEGRATIONS.scrubReasoningBlocks(rawReply)
        : { text: String(rawReply || ''), strippedCount: 0 };
    const safeReply = scrubIfPossible(reasoningScrubbed.text, explicitToken);
    const text = String(safeReply || '').replace(/\[(?:HARNESS_REPORT|AU_AGENT_READY)\][\s\S]*?\[\/(?:HARNESS_REPORT|AU_AGENT_READY)\]/g, '').trim();
    if (!text || isSystemPromptLike(text)) {
      return {
        usedTag: false,
        shareText: '',
        summary: '',
        fullExcerpt: '',
        isFinalReady: false,
        hasFinalMarker: false,
        finalDeliverable: '',
        sharedFiles: [],
        githubPushReadyMessage: '',
        githubUrls: [],
        consensusVote: null,
        strippedReasoningBlocks: reasoningScrubbed.strippedCount,
        boardUpdates: { assignments: [], contracts: [] }
      };
    }

    const artifacts = extractSharedFilesAndGitEvents(text);
    const boardUpdates = extractBoardUpdatesFromText(
      text,
      (meta && meta.slotKey) || 'ag1',
      (meta && meta.authorName) || 'Agente'
    );
    const finalMatch = text.match(/(?:^|\n)\s*\[ENTREGA_FINAL_PRONTA\](?:\s*\n|\s+)([\s\S]*)$/im);
    const isFinalReady = Boolean(finalMatch);
    const withoutFinalTag = text
      .replace(/\[ENTREGA_FINAL_PRONTA\]/gi, '')
      .replace(/\[MODULO_PRONTO_INTEGRACAO\]/gi, '')
      .replace(/\[VOTO_CONSENSO\s*:[^\]]*\]/gi, '')
      .replace(/\[GITHUB_PUSH_PRONTO\][\s\S]*?\[\/GITHUB_PUSH_PRONTO\]/gi, '')
      .replace(/\[ATRIBUICAO_(?:UNICA|ATUALIZAR)[^\]]*\][\s\S]*?\[\/ATRIBUICAO_(?:UNICA|ATUALIZAR)\]/gi, '')
      .replace(/\[CONTRATO_(?:UNICO|ATUALIZAR)[^\]]*\][\s\S]*?\[\/CONTRATO_(?:UNICO|ATUALIZAR)\]/gi, '')
      .trim();

    let finalDeliverable = '';
    if (isFinalReady) {
      const afterMarker = (finalMatch[1] || '')
        .replace(/\[TEMPCHAT\][\s\S]*?\[\/TEMPCHAT\]/gi, '')
        .replace(/\[GITHUB_PUSH_PRONTO\][\s\S]*?\[\/GITHUB_PUSH_PRONTO\]/gi, '')
        .trim();
      finalDeliverable =
        afterMarker.length >= 20
          ? afterMarker
          : withoutFinalTag.replace(/\[TEMPCHAT\][\s\S]*?\[\/TEMPCHAT\]/gi, '').trim() || withoutFinalTag;
    }

    // 1. Explicit [TEMPCHAT]...[/TEMPCHAT] block(s) — pick the latest clean block (anti-pollution capped!)
    const allTagMatches = Array.from(withoutFinalTag.matchAll(/\[TEMPCHAT\]([\s\S]*?)\[\/TEMPCHAT\]/gi));
    for (let ti = allTagMatches.length - 1; ti >= 0; ti--) {
      const candidateRaw = (allTagMatches[ti][1] || '').trim();
      const explicitMsgRaw = sanitizeConciseTeamMessage(candidateRaw, 980);
      const hasRealWords =
        /[A-Za-zÀ-ÿ0-9]{4,}/.test(explicitMsgRaw) &&
        !/^(?:\.{2,}|e|sua mensagem.*|resumo.*)$/i.test(explicitMsgRaw);
      if (hasRealWords && !isSystemPromptLike(explicitMsgRaw)) {
        let explicitMsg = explicitMsgRaw;
        if (artifacts.sharedFiles.length > 0) {
          const fileNote = artifacts.sharedFiles.map((f) => `📦 ${f.filename} (${f.provider}): ${f.url}`).join('\n');
          if (!explicitMsg.includes(artifacts.sharedFiles[0].url)) {
            explicitMsg += `\n\n${fileNote}`;
          }
        }
        return {
          usedTag: true,
          shareText: explicitMsg,
          summary: explicitMsg.slice(0, 700),
          fullExcerpt: explicitMsg,
          isFinalReady,
          hasFinalMarker: isFinalReady,
          finalDeliverable,
          sharedFiles: artifacts.sharedFiles,
          githubPushReadyMessage: artifacts.githubPushReadyMessage,
          githubUrls: artifacts.githubUrls,
          consensusVote: artifacts.consensusVote,
          strippedReasoningBlocks: reasoningScrubbed.strippedCount,
          boardUpdates
        };
      }
    }

    // 2. Clean anti-pollution fallback if model omitted [TEMPCHAT] tags (strips giant code blocks, caps to 480 chars!)
    if (isSystemPromptLike(withoutFinalTag)) {
      return {
        usedTag: false,
        shareText: '',
        summary: '',
        fullExcerpt: '',
        isFinalReady: false,
        hasFinalMarker: false,
        finalDeliverable: '',
        sharedFiles: artifacts.sharedFiles,
        githubPushReadyMessage: artifacts.githubPushReadyMessage,
        githubUrls: artifacts.githubUrls,
        consensusVote: artifacts.consensusVote,
        strippedReasoningBlocks: reasoningScrubbed.strippedCount,
        boardUpdates
      };
    }

    let fallbackShare = sanitizeConciseTeamMessage(withoutFinalTag, 480);
    if (artifacts.sharedFiles.length > 0 && fallbackShare && !fallbackShare.includes(artifacts.sharedFiles[0].url)) {
      fallbackShare += `\n📦 ${artifacts.sharedFiles.map((f) => `${f.filename}: ${f.url}`).join(' | ')}`;
    }

    return {
      usedTag: false,
      shareText: fallbackShare,
      summary: fallbackShare.slice(0, 480),
      fullExcerpt: fallbackShare,
      isFinalReady,
      hasFinalMarker: isFinalReady,
      finalDeliverable,
      sharedFiles: artifacts.sharedFiles,
      githubPushReadyMessage: artifacts.githubPushReadyMessage,
      githubUrls: artifacts.githubUrls,
      consensusVote: artifacts.consensusVote,
      strippedReasoningBlocks: reasoningScrubbed.strippedCount,
      boardUpdates
    };
  }

  function dedupeMessageArray(list) {
    const out = [];
    const seen = new Set();
    for (const m of Array.isArray(list) ? list : []) {
      const body = m.text || m.fullExcerpt || m.summary || '';
      const fp = m.fingerprint || computeMessageFingerprint(m.senderName || '', body);
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      out.push(m);
    }
    return out;
  }

  function buildNextCollabTurnPrompt(params = {}) {
    const roomId = params.roomId || (params.room && params.room.roomId) || '0000';
    const roleObj = params.agentRole || params.agent || {};
    const myName = roleObj.shortTitle || roleObj.agentName || 'Agente';
    const myTitle = roleObj.roleTitle || 'Especialista';
    const myIdx = Number(roleObj.agentIndex || (Number(roleObj.index || 0) + 1));
    const myHandle = `@Agente${myIdx}`;
    const isSynth = Boolean(roleObj.isSynthesizer || roleObj.isLeader);
    const nextRound = Number(params.roundNumber || (Number(roleObj.turnsContributed || 1) + 1));
    const unreadMessages = dedupeMessageArray(params.unreadMessages || []);
    const githubConfig = params.githubConfig || null;
    const sharedBoard = params.sharedBoard || (params.room && params.room.sharedBoard) || null;
    const integrationStatus =
      params.integrationStatus || (params.room ? computeRoomIntegrationStatus(params.room) : null);

    const rawTimerMins =
      params.sessionTimerMinutes !== undefined
        ? Number(params.sessionTimerMinutes)
        : params.room && params.room.sessionTimerMinutes !== undefined
          ? Number(params.room.sessionTimerMinutes)
          : global.AU_DEFAULTS && global.AU_DEFAULTS.DEFAULT_SETTINGS
            ? Number(global.AU_DEFAULTS.DEFAULT_SETTINGS.sessionMinTimerMinutes || 60)
            : 60;
    const sessionTimerMinutes = Math.max(0, Math.round(rawTimerMins));
    const remainingTimerMinutes = Math.max(0, Math.round(Number(params.remainingTimerMinutes || 0)));

    const coordMsgs = unreadMessages.filter(
      (m) =>
        m.senderType === 'user' ||
        m.senderType === 'external' ||
        m.senderType === 'coordinator' ||
        m.senderType === 'external_tempchat' ||
        (!m.senderType && /coordenador/i.test(String(m.sender || m.senderName || '')))
    );
    const peerMsgs = unreadMessages.filter((m) => m.senderType === 'agent');
    const directMentions = extractDirectMentionsForAgent(peerMsgs, myIdx, myName, myTitle);
    const overlaps = sharedBoard ? detectBoardFileOverlaps(sharedBoard) : [];

    // Ultra-short, zero-re-explanation follow-up prompt (Prompt #2 onwards!)
    const lines = [`🤝 [SALA TEMPCHAT #${roomId} • RODADA ${nextRound} • ${myHandle}]`];
    if (params.agentKitEnabled) lines.push(`Kit ${params.agentKitCompatible ? 'compatível' : 'sem handshake válido: copie doctor na resposta'}. Use /tmp/au_agent tick e /tmp/au_agent report; não reinstale nem repita o manual.`);
    if (params.harnessHint) lines.push(String(params.harnessHint).slice(0,480));

    if (coordMsgs.length > 0) {
      coordMsgs.slice(-2).forEach((m) => {
        const who = m.senderName || m.sender || 'Coordenador';
        const unv = m.externalUnverified ? ' [⛔ Não verificado]' : '';
        lines.push(`📢 ${who}${unv}: ${sanitizeConciseTeamMessage(m.text || m.fullExcerpt || m.summary || '', 320)}`);
      });
    }

    if (peerMsgs.length > 0) lines.push(`💬 Colegas: ${Array.from(new Set(peerMsgs.map(m => String(m.senderName || 'Colega').replace(/Agente\s+(\d+)/g, '@Agente$1')))).join(', ').slice(0, 300)} — /tmp/au_chat sync.`);
    if (directMentions.length > 0) {
      const dm = directMentions[directMentions.length - 1];
      lines.push(`🎯 ${dm.senderName} p/ ${myHandle}: ${sanitizeConciseTeamMessage(dm.excerpt, 180)}`);
    } else if (peerMsgs.length > 0) {
      const peerNames = Array.from(
        new Set(peerMsgs.slice(-5).map((m) => String(m.senderName || 'Colega').replace(/^⚡\s*/, '')))
      ).join(', ');
      lines.push(`💬 Novas mensagens no chat (${peerNames}) — leia e responda em \`/tmp/au_chat sync\`.`);
    }

    if (overlaps.length > 0) {
      const ov = overlaps[0];
      lines.push(`⚠️ Conflito de arquivo em \`${ov.path}\` (${ov.agents.join(' vs ')}) — negociem no \`/tmp/au_chat\`!`);
    }

    if (isSynth && integrationStatus && integrationStatus.isIntegrationReady && remainingTimerMinutes <= 0) {
      lines.push(
        `✅ Todos prontos no Quadro: rode \`/tmp/au_chat sync\` e \`/tmp/au_timer check\`, integre o trabalho real de todo o time e finalize com [ENTREGA_FINAL_PRONTA] somente se CAN_FINISH=YES; caso contrário continue a validação útil e o diálogo.`
      );
    } else if (sessionTimerMinutes > 0) {
      const timerLabel = formatSessionTimerLabel(sessionTimerMinutes);
      if (remainingTimerMinutes > 0 && remainingTimerMinutes < sessionTimerMinutes) {
        lines.push(
          `Continue e volte para o chat (\`/tmp/au_chat sync\`): ainda faltam ${remainingTimerMinutes} min reais na sua sessão de ${timerLabel}. Mantenha \`/tmp/au_timer check\` ativo verificando SEMPRE o horário real (nunca suponha que já passou o tempo!) e não pare de trabalhar no seu papel e interagir no chat ok.`
        );
      } else {
        lines.push(
          `Continue e volte para o chat (\`/tmp/au_chat sync\`), fique ativo por ${timerLabel} com o seu timer (\`/tmp/au_timer start ${sessionTimerMinutes}\`) verificando SEMPRE o horário real em \`/tmp/au_timer check\` (nunca suponha que já passou o tempo!) e não pare de trabalhar e interagir no chat ok.`
        );
      }
    } else {
      lines.push(
        `Continue e volte para o chat (\`/tmp/au_chat sync\`), trabalhe apenas nos arquivos do seu papel e não pare de colaborar e interagir com o time no chat ok.`
      );
    }

    const explicitTok = githubConfig && githubConfig.token ? githubConfig.token : '';
    const ending = lines.pop() || '';
    const bounded = lines.join('\n').slice(0, Math.max(0, 1999 - ending.length)) + '\n' + ending;
    return scrubIfPossible(bounded, explicitTok);
  }

  function quickHash(str) {
    const s = String(str || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36) + '_' + s.length;
  }

  function buildCodebaseBriefingBlock(mem) {
    if (!mem || typeof mem !== 'object') return '';
    const parts = [];
    if (mem.architectureSummary) parts.push(`• Arquitetura: ${String(mem.architectureSummary).trim()}`);
    if (mem.conventions) parts.push(`• Convenções: ${String(mem.conventions).trim()}`);
    if (Array.isArray(mem.decisionsLog) && mem.decisionsLog.length > 0) {
      parts.push(`• Decisões recentes:\n  - ${mem.decisionsLog.slice(-6).join('\n  - ')}`);
    }
    return parts.join('\n');
  }

  global.AU_COLLAB = {
    generateFourDigitCode,
    resolveGitRepoSpec,
    computeAgentBranchName,
    resolveEffectiveAgentAccessLevel,
    computeMessageFingerprint,
    createInitialSharedBoard,
    upsertBoardAssignment,
    upsertBoardContract,
    extractBoardUpdatesFromText,
    detectBoardFileOverlaps,
    sanitizeConciseTeamMessage,
    extractDirectMentionsForAgent,
    isAgentMentioned,
    computeRoomIntegrationStatus,
    computeRoomConsensusMatrix,
    formatSharedBoardSection,
    formatSessionTimerLabel,
    buildSessionTimerInstructions,
    buildCodebaseBriefingBlock,
    buildTeamRoles,
    buildRealtimeChatInstructions,
    buildTempFileHubInstructions,
    buildGithubInstructions,
    buildInitialAgentPrompt,
    extractSharedFilesAndGitEvents,
    extractTempChatShare,
    buildNextCollabTurnPrompt,
    isSystemPromptLike,
    quickHash
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
