(function (global) {
  'use strict';

  // Strictly genuine Token / Credit / Daily Usage exhaustion phrases (never Captcha or temporary burst 429!)
  const DEFAULT_TOKEN_LIMIT_PATTERNS = [
    'this session has reached its token usage limit',
    'reached the daily limit',
    'reached your daily limit',
    'daily usage limit',
    'your limit has been reached',
    'credits will refresh',
    'out of credits for today',
    'out of credits',
    'no credits remaining',
    'credit limit reached',
    'insufficient credits',
    'out of tokens',
    'token limit reached',
    'token usage limit',
    'session token limit',
    'limite de uso de tokens',
    'limite de tokens',
    'sem tokens',
    'atingiu o limite diário',
    'limite diário atingido',
    'sem créditos para hoje',
    'sem créditos',
    'créditos esgotados'
  ];

  const DEFAULT_CONDITIONAL_RULES = [
    {
      id: 'rule_fix_errors',
      name: 'Auto-Correção de Erros',
      enabled: true,
      pattern: '(traceback|syntaxerror|typeerror|referenceerror|command failed|exit_code:\\s*[1-9]|falha ao|erro ao compilar)',
      responsePrompt: 'Foram detectados erros na última execução. Analise a causa raiz, corrija os arquivos necessários, rode os testes/verificações novamente e continue o trabalho até tudo funcionar sem erros.'
    },
    {
      id: 'rule_auto_confirm',
      name: 'Auto-Confirmar Continuidade',
      enabled: true,
      pattern: '(posso prosseguir|deseja que eu continue|quer que eu implemente|shall i proceed|would you like me to continue|should i go ahead)',
      responsePrompt: 'Sim, prossiga imediatamente usando a melhor decisão técnica. Implemente tudo por completo sem pausar para confirmações intermediárias.'
    },
    {
      id: 'rule_auto_pr_github',
      name: 'Auto-Aprovar Git Push & Pull Request Direto (Zero Loop Humano)',
      enabled: true,
      pattern: '(posso abrir (?:o |um )?(?:pr|pull request)|quer que eu (?:abra|crie).*(?:pr|pull request)|deseja que eu fa[cç]a.*push|posso fazer.*push|create a pull request\\?|shall i (?:push|open a pr)|conectar.*github|list_connector_tools)',
      responsePrompt: 'Você já tem autorização 100% autônoma (sem humano no loop)! NÃO peça confirmação e NÃO use conectores externos: execute imediatamente no bash `/tmp/au_gh pr-ship` (ou `git push -u origin HEAD` + abertura do PR via `/tmp/au_gh`) e continue as próximas etapas!'
    },
    {
      id: 'rule_pending_steps',
      name: 'Avançar Próximas Etapas',
      enabled: true,
      pattern: '(próximo passo|próxima etapa|next steps?|etapa pendente|to do:|faltam implementar|restante do projeto)',
      responsePrompt: 'Ótimo avanço! Agora execute imediatamente todas as próximas etapas pendentes listadas, validando cada entrega na prática.'
    }
  ];

  const DEFAULT_WORKFLOW_MACROS = [
    {
      id: 'macro_fullstack_builder',
      name: 'Construção Full-Stack Completa',
      description: 'Planeja arquitetura, desenvolve backend/frontend, testa tudo e refina o visual antes de entrar em loop contínuo.',
      steps: [
        'Analise todos os requisitos, defina uma arquitetura limpa e comece implementando a estrutura base completa do projeto.',
        'Implemente todas as funcionalidades principais, integrações de dados, estados de carregamento e tratamento completo de erros.',
        'Execute testes reais no ambiente, verifique cada funcionalidade criada, corrija eventuais bugs e valide os fluxos de ponta a ponta.',
        'Faça um polimento completo de UI/UX, responsividade, acessibilidade e documentação final.'
      ],
      loopPromptAfterQueue: 'Revise todo o projeto em busca de melhorias extras, casos de borda não tratados, otimizações de performance ou funcionalidades incompletas e implemente-as.'
    },
    {
      id: 'macro_bug_hunter',
      name: 'Caça-Bugs, Testes & Blindagem',
      description: 'Inspeciona todo o workspace, reproduz falhas, corrige bugs e cria testes automatizados.',
      steps: [
        'Inspecione todos os arquivos do projeto, identifique bugs, gargalos, problemas de tipagem ou falhas lógicas e liste o plano de correção.',
        'Aplique todas as correções necessárias no código sem quebrar funcionalidades existentes.',
        'Crie e execute testes automatizados cobrindo os cenários principais e casos extremos, garantindo 100% de aprovação.'
      ],
      loopPromptAfterQueue: 'Continue auditando o código, expandindo a cobertura de testes e refinando a estabilidade geral do sistema.'
    },
    {
      id: 'macro_deep_research',
      name: 'Pesquisa Profunda & Dossiê Completo',
      description: 'Investiga fontes, cruza dados atuais, gera tabelas comparativas e consolida documento executivo.',
      steps: [
        'Faça uma pesquisa ampla e atualizada sobre o tema solicitado, levantando dados concretos, fontes confiáveis e panorama completo.',
        'Aprofunde nos detalhes técnicos, métricas comparativas, prós/contras e estudos de caso reais.',
        'Consolide tudo em um documento completo, bem estruturado e rico em tabelas e conclusões práticas no workspace.'
      ],
      loopPromptAfterQueue: 'Expanda a pesquisa com análises complementares, verificação extra de dados e exemplos práticos adicionais.'
    },
    {
      id: 'macro_ui_polish',
      name: 'Refinamento Visual & UX Pro',
      description: 'Eleva o nível visual de uma aplicação com micro-interações, estados vazios e design responsivo.',
      steps: [
        'Audite toda a interface atual identificando pontos de melhoria em hierarquia visual, espaçamento, contraste e consistência.',
        'Refatore os estilos e componentes aplicando design limpo, responsivo, feedback visual claro e estados vazios elegantes.',
        'Valide a renderização ao vivo, corrija qualquer desalinhamento e garanta fluidez total.'
      ],
      loopPromptAfterQueue: 'Continue aprimorando detalhes visuais, usabilidade e acabamento de cada tela do projeto.'
    }
  ];

  const DEFAULT_PROMPTS = [
    {
      id: 'prm_continue_agent',
      slash: '/continuar',
      title: 'Continuar Trabalho Autônomo',
      category: 'Agent Mode',
      favorite: true,
      content: 'Continue o trabalho exatamente de onde parou. Execute todas as etapas restantes, valide o resultado na prática e não pare até concluir tudo com excelência.'
    },
    {
      id: 'prm_architect',
      slash: '/arquitetar',
      title: 'Arquitetar & Construir Projeto',
      category: 'Engenharia',
      favorite: true,
      content: 'Crie o projeto "{{projeto}}" utilizando {{stack}}. Estruture uma arquitetura modular limpa, implemente todas as funcionalidades sem placeholders, teste no ambiente e entregue pronto para uso. Requisitos extras: {{requisitos}}.'
    },
    {
      id: 'prm_debug',
      slash: '/debug',
      title: 'Diagnóstico & Correção de Bug',
      category: 'Engenharia',
      favorite: true,
      content: 'Investigue o seguinte problema em {{arquivo}}: "{{erro}}". Reproduza a falha, encontre a causa raiz exata, aplique a correção definitiva e valide que tudo voltou a funcionar.'
    },
    {
      id: 'prm_review',
      slash: '/revisar',
      title: 'Code Review Rigoroso',
      category: 'Qualidade',
      favorite: false,
      content: 'Faça uma revisão completa focada em {{foco}}. Identifique vulnerabilidades, bugs silenciosos, código duplicado e oportunidades de melhoria, aplicando as correções diretamente.'
    },
    {
      id: 'prm_tests',
      slash: '/testes',
      title: 'Gerar & Rodar Suíte de Testes',
      category: 'Qualidade',
      favorite: false,
      content: 'Crie testes automatizados abrangentes para {{escopo}}, cobrindo fluxos principais e casos de borda. Execute todos os testes no terminal e corrija qualquer falha encontrada.'
    },
    {
      id: 'prm_fullstack',
      slash: '/fullstack',
      title: 'Aplicação Web com Preview ao Vivo',
      category: 'Agent Mode',
      favorite: true,
      content: 'Construa uma aplicação web completa para "{{ideia}}" com visual {{estilo}}. Implemente todas as interações reais, persistência de dados e inicie o servidor para preview ao vivo.'
    },
    {
      id: 'prm_optimize',
      slash: '/otimizar',
      title: 'Otimizar Performance & Código',
      category: 'Engenharia',
      favorite: false,
      content: 'Analise o desempenho atual do projeto, reduza gargalos de processamento/renderização, limpe código morto e mantenha 100% do comportamento funcional.'
    },
    {
      id: 'prm_summary',
      slash: '/resumir',
      title: 'Resumo Executivo da Sessão',
      category: 'Organização',
      favorite: false,
      content: 'Gere um resumo estruturado em Markdown de tudo o que foi construído/decidido até agora nesta sessão, listando arquivos criados, arquitetura e próximos passos.'
    }
  ];

  const PRESET_THEMES = {
    native: {
      id: 'native',
      name: 'Nativo Arena',
      subtitle: 'Visual oficial limpo do Arena.ai',
      swatches: ['#ffffff', '#18181b', '#10b981'],
      css: ''
    },
    oled: {
      id: 'oled',
      name: 'OLED Pure Black',
      subtitle: 'Preto puro #000 com contraste máximo',
      swatches: ['#000000', '#0a0a0c', '#10b981'],
      css: `
        html, body, main, [data-theme], .dark body {
          background-color: #000000 !important;
          color: #f4f4f5 !important;
        }
        header, nav, aside, [role="navigation"], [data-sidebar="sidebar"], .bg-sidebar {
          background-color: #050507 !important;
          border-color: #18181b !important;
        }
        pre, code {
          background-color: #09090d !important;
          border-color: #1f1f26 !important;
        }
        textarea, form, .bg-surface-secondary {
          background-color: #0a0a0e !important;
          color: #fafafa !important;
          border-color: #27272a !important;
        }
      `
    },
    dracula: {
      id: 'dracula',
      name: 'Dracula Pro',
      subtitle: 'Tons noturnos violeta e ciano clássico',
      swatches: ['#1e1f29', '#282a36', '#bd93f9'],
      css: `
        html, body, main {
          background-color: #1e1f29 !important;
          color: #f8f8f2 !important;
        }
        header, nav, aside, [role="navigation"], [data-sidebar="sidebar"], .bg-sidebar {
          background-color: #191a23 !important;
          border-color: #343746 !important;
        }
        pre, code {
          background-color: #15161e !important;
          border-color: #44475a !important;
        }
        textarea, form, .bg-surface-secondary {
          background-color: #282a36 !important;
          color: #f8f8f2 !important;
          border-color: #6272a4 !important;
        }
        a { color: #8be9fd !important; }
      `
    },
    nord: {
      id: 'nord',
      name: 'Nord Frost',
      subtitle: 'Paleta ártica suave para foco prolongado',
      swatches: ['#2e3440', '#3b4252', '#88c0d0'],
      css: `
        html, body, main {
          background-color: #2e3440 !important;
          color: #eceff4 !important;
        }
        header, nav, aside, [role="navigation"], [data-sidebar="sidebar"], .bg-sidebar {
          background-color: #242933 !important;
          border-color: #434c5e !important;
        }
        pre, code {
          background-color: #232831 !important;
          border-color: #4c566a !important;
        }
        textarea, form, .bg-surface-secondary {
          background-color: #3b4252 !important;
          color: #eceff4 !important;
          border-color: #4c566a !important;
        }
        a { color: #88c0d0 !important; }
      `
    },
    cyberpunk: {
      id: 'cyberpunk',
      name: 'Cyberpunk Neon',
      subtitle: 'Azul abissal com acentos neon vibrantes',
      swatches: ['#080b14', '#101626', '#00f0ff'],
      css: `
        html, body, main {
          background-color: #080b14 !important;
          color: #e2f1ff !important;
        }
        header, nav, aside, [role="navigation"], [data-sidebar="sidebar"], .bg-sidebar {
          background-color: #05070e !important;
          border-color: rgba(0, 240, 255, 0.22) !important;
        }
        pre, code {
          background-color: #0b1020 !important;
          border: 1px solid rgba(255, 42, 133, 0.28) !important;
        }
        textarea, form, .bg-surface-secondary {
          background-color: #0d1324 !important;
          color: #f0f9ff !important;
          border-color: rgba(0, 240, 255, 0.38) !important;
          box-shadow: 0 0 16px rgba(0, 240, 255, 0.08) !important;
        }
        a { color: #00f0ff !important; }
      `
    },
    glass: {
      id: 'glass',
      name: 'Minimal Glass',
      subtitle: 'Superfícies translúcidas com gradiente sutil',
      swatches: ['#0f172a', '#1e293b', '#38bdf8'],
      css: `
        html, body, main {
          background: radial-gradient(circle at top right, #172033 0%, #0b0f19 65%) !important;
          color: #f1f5f9 !important;
        }
        header, nav, [role="navigation"], [data-sidebar="sidebar"], .bg-sidebar {
          background-color: rgba(15, 23, 42, 0.72) !important;
          backdrop-filter: blur(14px) !important;
          border-color: rgba(148, 163, 184, 0.16) !important;
        }
        pre, code {
          background-color: rgba(15, 23, 42, 0.78) !important;
          border-color: rgba(148, 163, 184, 0.2) !important;
        }
        textarea, form, .bg-surface-secondary {
          background-color: rgba(30, 41, 59, 0.68) !important;
          backdrop-filter: blur(12px) !important;
          color: #f8fafc !important;
          border-color: rgba(56, 189, 248, 0.28) !important;
        }
      `
    },
    high_contrast: {
      id: 'high_contrast',
      name: 'Alto Contraste AAA',
      subtitle: 'Contraste WCAG 7:1+ com foco nítido e zero transparência',
      swatches: ['#000000', '#ffffff', '#ffff00'],
      css: `
        html, body, main {
          background-color: #000000 !important;
          color: #ffffff !important;
        }
        header, nav, [role="navigation"], [data-sidebar="sidebar"], .bg-sidebar {
          background-color: #000000 !important;
          border-color: #ffffff !important;
        }
        pre, code {
          background-color: #050505 !important;
          color: #ffffff !important;
          border: 2px solid #ffffff !important;
        }
        textarea, form, .bg-surface-secondary {
          background-color: #000000 !important;
          color: #ffffff !important;
          border: 2px solid #ffff00 !important;
        }
        a, button:focus-visible, [tabindex]:focus-visible {
          color: #ffff00 !important;
          outline: 2px solid #ffff00 !important;
          outline-offset: 2px !important;
        }
      `
    }
  };

  const DEFAULT_FOLDERS = [
    { id: 'fld_agents', name: 'Sessões Agent', color: '#10b981' },
    { id: 'fld_swarm', name: 'Lotes Multi-Agent', color: '#6366f1' },
    { id: 'fld_code', name: 'Projetos & Código', color: '#f59e0b' },
    { id: 'fld_battle', name: 'Destaques Battle', color: '#ec4899' }
  ];

  const COLLAB_PROFILES = {
    specialists: {
      id: 'specialists',
      name: 'Equipe de Especialistas (Arquiteto + Dev + QA + Líder)',
      label: 'Equipe de Especialistas (Arquiteto + Dev + QA + Líder)',
      shortName: 'Especialistas',
      description: 'Cada Agente assume uma especialidade complementar e o Líder Sintetizador integra tudo.'
    },
    parallel_leader: {
      id: 'parallel_leader',
      name: 'Divisão Paralela + Líder Sintetizador (Mais Rápido)',
      label: 'Divisão Paralela + Líder Sintetizador (Mais Rápido)',
      shortName: 'Divisão Paralela',
      description: 'Divide a tarefa em frentes paralelas sem retrabalho e junta tudo em tempo recorde.'
    },
    debate_consensus: {
      id: 'debate_consensus',
      name: 'Debate, Revisão Mútua & Consenso (Maior Qualidade)',
      label: 'Debate, Revisão Mútua & Consenso (Maior Qualidade)',
      shortName: 'Debate & Consenso',
      description: 'Todos atacam o problema, revisam criticamente o TempChat dos colegas e convergem na melhor entrega.'
    }
  };

  const COLLAB_STOP_MODES = {
    smart_consensus: {
      id: 'smart_consensus',
      name: 'Parada Inteligente na Entrega Final',
      label: 'Parada Inteligente na Entrega Final',
      description: 'Conclui e avisa automaticamente quando o Líder publicar [ENTREGA_FINAL_PRONTA] após colaboração da equipe.'
    },
    endless_tokens: {
      id: 'endless_tokens',
      name: 'Refinamento Contínuo até Esgotar Tokens',
      label: 'Refinamento Contínuo até Esgotar Tokens',
      description: 'A equipe continua aprimorando, testando e expandindo em conjunto no TempChat até acabar os tokens ou você pausar.'
    }
  };

  const TEMP_FILE_PROVIDERS = {
    filebin: {
      id: 'filebin',
      name: 'Filebin.net (Bucket Compartilhado da Sala • 6 dias)',
      shortName: 'Filebin.net',
      siteUrl: 'https://filebin.net',
      maxSizeLabel: 'Bucket Multi-Arquivos'
    },
    litterbox: {
      id: 'litterbox',
      name: 'Litterbox / Catbox (Link Direto • 1h–72h • até 1 GB)',
      shortName: 'Litterbox',
      siteUrl: 'https://litterbox.catbox.moe',
      maxSizeLabel: 'Até 1 GB'
    },
    uguu: {
      id: 'uguu',
      name: 'Uguu.se (Link Direto Rápido • até 128 MB)',
      shortName: 'Uguu.se',
      siteUrl: 'https://uguu.se',
      maxSizeLabel: 'Até 128 MB'
    },
    x0at: {
      id: 'x0at',
      name: 'x0.at (Host Temporário CLI • até 512 MB)',
      shortName: 'x0.at',
      siteUrl: 'https://x0.at',
      maxSizeLabel: 'Até 512 MB'
    }
  };

  const PROMPT_TEMPLATE_VERSION = '4.5.0';

  const GITHUB_AUTH_MODES = {
    vault_broker_zero_token: {
      id: 'vault_broker_zero_token',
      label: '🔐 Cofre Broker Zero-Token (Padrão Obrigatório v4.0 • Token Nunca Entra no Prompt)',
      description: 'O Token PAT permanece isolado em memória de sessão (ou cifrado AES-256-GCM), com controle RBAC por Agente, auditoria sanitizada e broker /tmp/au_gh + proxy CAS direto.'
    },
    extension_proxy_push: {
      id: 'extension_proxy_push',
      label: '🛡️ Push & PR via Proxy CAS da Extensão (Somente Navegador • Zero Token no Chat)',
      description: 'A extensão exporta diretamente o Workspace CAS completo e executa commit/PR via API do GitHub sem expor segredos nem usar hosts intermediários em repositórios privados.'
    }
  };

  function normalizeGithubAuthMode(rawMode) {
    // SEC-01: Legacy direct_agent_git is retired and coerced to vault_broker_zero_token
    if (rawMode === 'extension_proxy_push') return 'extension_proxy_push';
    return 'vault_broker_zero_token';
  }

  const GITHUB_AGENT_ACCESS_LEVELS = {
    auto_role: {
      id: 'auto_role',
      label: 'Automático por Papel (Líder: Push+PR • Especialistas: Própria Branch • QA: Leitura)',
      shortLabel: '⚙️ Auto (Papel)'
    },
    push_and_pr: {
      id: 'push_and_pr',
      label: '🚀 Leitura + Push na Branch + Abrir/Atualizar PR',
      shortLabel: '🚀 Push + PR'
    },
    push_branch: {
      id: 'push_branch',
      label: '🌿 Leitura + Push Apenas na Própria Branch (Sem abrir PR)',
      shortLabel: '🌿 Só Branch'
    },
    read_only: {
      id: 'read_only',
      label: '👁️ Somente Leitura (Code, Issues, PRs, Actions — Sem Push)',
      shortLabel: '👁️ Só Leitura'
    },
    revoked: {
      id: 'revoked',
      label: '🔒 Acesso Revogado / Bloqueado no Cofre',
      shortLabel: '🔒 Revogado'
    }
  };

  const INTEGRATION_STATES = {
    bootstrap: {
      id: 'bootstrap',
      label: '🟡 Inicializando Equipe & Contratos',
      badgeColor: '#f59e0b'
    },
    implementing: {
      id: 'implementing',
      label: '🔵 Implementação Paralela Ativa',
      badgeColor: '#3b82f6'
    },
    awaiting_peers: {
      id: 'awaiting_peers',
      label: '🟣 Aguardando Módulos Pendentes',
      badgeColor: '#a855f7'
    },
    waiting_user: {
      id: 'waiting_user',
      label: '⏸ Aguardando Escolha Humana no Card',
      badgeColor: '#eab308'
    },
    needs_human: {
      id: 'needs_human',
      label: '⚠️ Pausa Objetiva (Decisão Humana Necessária)',
      badgeColor: '#ef4444'
    },
    ready_for_synthesis: {
      id: 'ready_for_synthesis',
      label: '🟢 Pronto p/ Integração Final (Todos os Módulos Prontos!)',
      badgeColor: '#10b981'
    },
    timed_out_ready: {
      id: 'timed_out_ready',
      label: '⏰ Tempo Limite Atingido — Integração Final Liberada!',
      badgeColor: '#f97316'
    },
    completed: {
      id: 'completed',
      label: '✅ Integração Final Concluída',
      badgeColor: '#10b981'
    }
  };

  const GITHUB_BRANCH_MODES = {
    branch_per_agent_pr: {
      id: 'branch_per_agent_pr',
      label: 'Branch por Agente + Merge/PR pelo Líder',
      description: 'Cada especialista trabalha em sua branch isolada e o Líder Sintetizador integra tudo e abre o Pull Request.'
    },
    single_shared_branch: {
      id: 'single_shared_branch',
      label: 'Branch Única Compartilhada (pull --rebase)',
      description: 'Todos os Agents sincronizam com git pull --rebase e iteram juntos na mesma branch colaborativa.'
    }
  };

  const DEFAULT_SETTINGS = {
    settingsVersion: 6,
    harnessEnabled: true,
    agentKitEnabled: false, // Enable after publishing the pinned public Agent Kit release.
    locale: 'pt-BR', // 'pt-BR' | 'en' | 'es' (UX-01)
    onboardingCompleted: false,
    emergencyStopActive: false,

    // Auto-Continue Core
    autoContinueStrategy: 'hybrid', // 'fixed' | 'queue' | 'conditional' | 'hybrid'
    fixedContinuePrompt: 'Continue de onde parou, verifique o horário real no seu timer (/tmp/au_timer check — nunca suponha que o tempo passou!) e não pare de trabalhar e validar até fechar o ciclo, ok?',
    sessionMinTimerMinutes: 60, // Mínimo 60 min (1h) por sessão com /tmp/au_timer verificando relógio real (evita sessões curtas e spam de prompts!)
    settleDelayMs: 3400,
    sendDelayMs: 1600,
    hardStopOnTokenLimit: true,
    sessionTokenBudgetLimit: 0, // 0 = ilimitado | >0 = pausa sessão quando estimativa atingir X tokens (UX-06)
    tokenLimitPatterns: DEFAULT_TOKEN_LIMIT_PATTERNS,
    conditionalRules: DEFAULT_CONDITIONAL_RULES,
    autoAnswerHumanCardsAllowlist: '', // Vazio por padrão = pausa em WAITING_USER em ask_user/add_voice/generate_image (ARENA-04)

    // Task Authorization Policy & Operational Budgets (ARENA-11)
    taskPolicyMode: 'scoped', // 'scoped' | 'full_auto_permanent'
    taskMaxLoopsBudget: 60,
    taskMaxCommitsBudget: 40,
    taskMaxPrsBudget: 12,
    taskMaxUploadsBudget: 80,
    taskAllowDeletionsOnCompleteSnapshot: true,
    taskMaxAutoDeletionsPerCommit: 15,

    // Multi-Agent Launcher & Orchestration
    launcherDefaultUrl: 'https://arena.ai/agent',
    launcherStaggerMs: 4500,
    launcherSequentialWait: true,
    launcherAutoEnableLoop: true,
    launcherAutoGroupTabs: true,
    launcherTabGroupName: 'Arena Ultra • Agents',
    launcherTabGroupColor: 'green',
    antiThrottleEnabled: true,

    // Multi-Agent TempChat Collaboration & Integration SLA Defaults
    collabDefaultProfile: 'specialists',
    collabDefaultStopMode: 'smart_consensus',
    collabMirrorExternalTempChat: false,
    collabIntegrationTimeoutMinutes: 65,
    collabMaxRoundsBeforeSynthesis: 6,

    // Anti-Thinking Model Refusal & Team Admission Gate (DEFAULT FEATURE = ON!)
    refuseThinkingModels: true,
    refuseThinkingAutoReroll: true,
    refuseThinkingMaxRetries: 15,

    // GitHub Integration & Credential Vault Defaults (SEC-01, SEC-02, SEC-06)
    githubToken: '', // Nunca persistido em texto claro no storage.local — hidratado via storage.session!
    githubTokenStorageMode: 'session_only', // 'session_only' | 'encrypted_disk'
    githubUsername: '',
    githubDefaultRepo: '',
    githubBaseBranch: 'main',
    githubAuthMode: 'vault_broker_zero_token', // 'vault_broker_zero_token' | 'extension_proxy_push'
    githubVaultSessionTtlMinutes: 480,
    githubDefaultAgentAccessMode: 'auto_role',
    githubAutoNotifyBranchesPrs: true,
    githubBranchMode: 'branch_per_agent_pr',
    githubEnabledInCollab: true,
    githubAutoCreatePR: true,
    githubAutoDetectInPrompt: true,
    encryptedPrivateArtifactsOptIn: false, // SEC-06 / ARENA-08: privado usa proxy CAS direto por padrão!

    // Temporary File Hub Defaults (Filebin + Litterbox + Uguu.se + x0.at)
    tempFilesEnabledInCollab: true,
    tempFilePrimaryProvider: 'filebin', // 'filebin' | 'litterbox' | 'uguu' | 'x0at'
    tempFileAutoFallback: true,
    litterboxExpiry: '24h', // '1h' | '12h' | '24h' | '72h'

    // Alerts & Notifications
    desktopNotifications: true,
    soundEnabled: true,
    blinkTabTitle: true,
    badgeEnabled: true,
    webhookUrl: '', // Isolado em storage.session (SEC-02 / SEC-03)

    // UI Surfaces (No global keyboard shortcuts per user preference!)
    promptToolbarVisible: true,
    fabVisible: true,
    slashCommandsEnabled: true,
    autoSaveSnapshots: true,
    hideAutoPromptsInChat: true,
    hideSystemLogsInLiveChat: true,

    // Visual Customization
    activeTheme: 'native',
    zenMode: false,
    chatWidthPercent: 0, // 0 = native default, 70..100 = custom widescreen
    fontSizePx: 0,       // 0 = native default, 13..20 = custom font size
    fontFamily: 'native' // 'native' | 'inter' | 'jetbrains' | 'serif'
  };

  const DEFAULT_METRICS = {
    totalAutoLoopsSent: 0,
    totalBatchesLaunched: 0,
    totalAgentTabsSpawned: 0,
    totalTokenLimitStops: 0,
    totalCompletedSessions: 0,
    totalCollabRoomsCreated: 0,
    totalCollabMessagesExchanged: 0,
    totalTempFilesShared: 0,
    totalGithubCommitsPushed: 0,
    totalGithubPRsCreated: 0,
    totalThinkingModelsRefused: 0,
    estimatedPromptTokens: 0,
    estimatedOutputTokens: 0,
    totalActiveRuntimeSec: 0,
    sessionLogs: [], // { id, timestamp, tabTitle, url, eventType, loopsCount, details }
    battleVotes: [], // { id, timestamp, winner, modelA, modelB, promptSnippet }
    modelNotes: {}   // { [modelName]: { rating, notes, wins, losses, ties } }
  };

  function normalizePromptKey(str) {
    return String(str || '')
      .replace(/[`*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  const BUILTIN_AUTO_PROMPT_KEYS = (() => {
    const list = [
      DEFAULT_SETTINGS.fixedContinuePrompt,
      'continue executando autonomamente de onde parou',
      'continue o trabalho exatamente de onde parou',
      'execute imediatamente todos os itens pendentes.'
    ];
    for (const r of DEFAULT_CONDITIONAL_RULES) {
      if (r && r.responsePrompt) list.push(r.responsePrompt);
    }
    for (const m of DEFAULT_WORKFLOW_MACROS) {
      if (m && m.loopPromptAfterQueue) list.push(m.loopPromptAfterQueue);
      if (m && Array.isArray(m.steps)) {
        for (const st of m.steps) list.push(st);
      }
    }
    return new Set(list.map(normalizePromptKey).filter(Boolean));
  })();

  const SYSTEM_AUTO_PROMPT_ENVELOPE_RX =
    /(?:AGENT KIT \d+\.\d+\.\d+|🤝\s*[\[*]*\s*(?:SALA TEMPCHAT|CONECTADO EM TEMPO REAL À SALA TEMPCHAT)\s*#\d+|⏱️\s*\[?\s*(?:TIMER OBRIGATÓRIO DE SESSÃO|SESSÃO ATIVA COM TIMER REAL)|MODO COLABORAÇÃO MULTI-AGENT EM TEMPO REAL|PACTO DE TIME UNIDO\s*[—•-]\s*ZERO COMPETIÇÃO|FASE\s*\d+\s*[—•-]\s*(?:RODA DE ALINHAMENTO|EXECUÇÃO COORDENADA|CONVERGÊNCIA\s*&\s*SÍNTESE)|🗣️\s*DIÁLOGO DIRETO COM VOCÊ|💬\s*CONVERSA RECENTE DO TIME|🗺️\s*DIVISÃO VIVA DO TIME|LEMBRETE RÁPIDO\s*`?\/tmp\/au_chat`?|SINCRONIZAÇÃO EM TEMPO REAL\s*•\s*RODADA\s*\d+|EQUIPE CONECTADA NESTA SALA TEMPCHAT AGORA\s*:|QUADRO COMPARTILHADO DE ATRIBUIÇÕES\s*&\s*CONTRATOS|ESTADO\s*&\s*TEMPO LIMITE DA INTEGRAÇÃO FINAL|COFRE DE CREDENCIAIS GIT\s*\(ZERO TOKEN NO PROMPT\)|SUA MISSÃO AGORA NESTA RODADA\s*:|REGRAS DE CONVERSA EM TEMPO REAL\s*&\s*EXECUÇÃO NESTA RODADA\s*:|NOVAS MENSAGENS DOS SEUS COLEGAS NA SALA TEMPCHAT|ORIENTAÇÃO AO VIVO DO COORDENADOR HUMANO\s*\/\s*TEMPCHAT EXTERNO|💬\s*\[?\s*MENSAGEM AO VIVO DO COORDENADOR HUMANO NO CHAT LIVE|⚡\s*CHAT EM TEMPO REAL ENTRE OS AGENTS NO TERMINAL|CONVERSA EM TEMPO REAL ENTRE OS MODELOS DURANTE O TURNO|HUB DE ARQUIVOS TEMPORÁRIOS DA EQUIPE|INTEGRAÇÃO GITHUB (?:DIRETA|PÚBLICA|ATIVA|AUTÔNOMA|SEGURA|COFRE)|LEMBRETE GITHUB AUTÔNOMO\s*\(|MODO DE PARADA INTELIGENTE\s*(?:\(|:)|MODO DE REFINAMENTO CONTÍNUO ATÉ ESGOTAR TOKENS\s*:)/i;

  function isSystemOrAutoPromptText(text, extraPrompts) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (SYSTEM_AUTO_PROMPT_ENVELOPE_RX.test(raw)) return true;

    // Catch partial/sliced fragments of injected bash setup blocks WITHOUT matching normal Agent prose mentioning `/tmp/au_gh pr-ship`!
    if (
      (raw.includes('/tmp/au_chat') &&
        (raw.includes("cat << 'EOF' > /tmp/au_chat") ||
          raw.includes("cat << 'AUCHAT_EOF' > /tmp/au_chat") ||
          raw.includes('Sua Identidade na Sala:') ||
          raw.includes('Seu Papel:'))) ||
      (raw.includes('/tmp/au_git_askpass.sh') &&
        (raw.includes("cat << 'EOF' > /tmp/au_git_askpass.sh") ||
          raw.includes('git config --global core.askPass /tmp/au_git_askpass.sh') ||
          raw.includes('GIT_TERMINAL_PROMPT=0'))) ||
      (raw.includes('/tmp/au_gh') &&
        (raw.includes("cat << 'EOF' > /tmp/au_gh") ||
          raw.includes("cat << 'AUGH_EOF' > /tmp/au_gh") ||
          raw.includes('VAULT_CAP = ') ||
          (raw.includes('#!/usr/bin/env python3') && raw.includes('ASKPASS = "/tmp/au_git_askpass.sh"')))) ||
      (raw.includes('/tmp/au_upload') && raw.includes("cat << 'EOF' > /tmp/au_upload") && raw.includes('verified=2024-05-24'))
    ) {
      return true;
    }

    const norm = normalizePromptKey(raw);
    if (!norm) return false;
    if (BUILTIN_AUTO_PROMPT_KEYS.has(norm)) return true;

    if (Array.isArray(extraPrompts)) {
      for (let i = 0; i < extraPrompts.length; i++) {
        const k = normalizePromptKey(extraPrompts[i]);
        if (k && k.length >= 6 && norm === k) return true;
      }
    }
    return false;
  }

  function extractCleanObjectiveFromAutoPrompt(text) {
    const raw = String(text || '');
    if (!raw) return '';
    if (/AGENT KIT \d+\.\d+\.\d+/.test(raw)) {
      const kitTask = raw.match(/OBJETIVO DA EQUIPE:\n([\s\S]*?)\n(?:SUA FRENTE:|Papel:)/);
      if (kitTask) return kitTask[1].trim();
    }
    if (/MODO COLABORAÇÃO MULTI-AGENT EM TEMPO REAL/i.test(raw)) {
      const m = raw.match(
        /OBJETIVO(?:\s+GERAL)?\s+DA\s+EQUIPE\s*:\s*\n?([\s\S]*?)(?:\n*\s*(?:SUA FRENTE ESPECÍFICA INICIAL|FASE\s*1\s*[—•-]|🗺️\s*DIVISÃO VIVA DO TIME|📋\s*QUADRO COMPARTILHADO|QUADRO COMPARTILHADO DE ATRIBUIÇÕES|⏱️\s*(?:TIMER OBRIGATÓRIO DE SESSÃO|ESTADO\s*&\s*TEMPO LIMITE)|ESTADO\s*&\s*TEMPO LIMITE DA INTEGRAÇÃO|🔐\s*COFRE DE CREDENCIAIS GIT|⚡\s*CHAT EM TEMPO REAL ENTRE OS AGENTS|⚡\s*CHAT EM TEMPO REAL|CHAT EM TEMPO REAL ENTRE OS AGENTS NO TERMINAL|💬\s*CONVERSA EM TEMPO REAL|CONVERSA EM TEMPO REAL ENTRE OS MODELOS|🐙\s*INTEGRAÇÃO GITHUB|INTEGRAÇÃO GITHUB|📦\s*HUB DE ARQUIVOS|HUB DE ARQUIVOS TEMPORÁRIOS|REGRAS DE CONVERSA EM TEMPO REAL)\b|$)/i
      );
      if (!m || !m[1]) return '';
      const clean = m[1].trim();
      if (!clean || SYSTEM_AUTO_PROMPT_ENVELOPE_RX.test(clean)) return '';
      return clean;
    }
    if (/CONECTADO EM TEMPO REAL À SALA TEMPCHAT\s*#\d+/i.test(raw)) {
      const um = raw.match(
        /Objetivo\s+Conjunto\s*:\s*([\s\S]*?)(?:\n*\s*(?:📋\s*QUADRO COMPARTILHADO|⏱️\s*(?:TIMER OBRIGATÓRIO DE SESSÃO|ESTADO\s*&\s*TEMPO LIMITE)|🔐\s*COFRE DE CREDENCIAIS GIT|⚡\s*CHAT EM TEMPO REAL|CHAT EM TEMPO REAL ENTRE OS AGENTS|💬\s*CONVERSA EM TEMPO REAL|🐙\s*INTEGRAÇÃO GITHUB|INTEGRAÇÃO GITHUB|📦\s*HUB DE ARQUIVOS|Execute agora seu 1º comando bash)\b|$)/i
      );
      if (um && um[1]) {
        const cleanUnite = um[1].trim();
        if (cleanUnite && !SYSTEM_AUTO_PROMPT_ENVELOPE_RX.test(cleanUnite)) {
          return cleanUnite;
        }
      }
    }
    if (/MENSAGEM AO VIVO DO COORDENADOR HUMANO NO CHAT LIVE/i.test(raw)) {
      const cm = raw.match(
        /MENSAGEM AO VIVO DO COORDENADOR HUMANO NO CHAT LIVE[^\n]*\]:\s*\n+"?([\s\S]*?)"?\s*\n+Responda e aplique esta orientação/i
      );
      if (cm && cm[1] && cm[1].trim()) {
        return cm[1].trim();
      }
    }
    // Solo / non-collab prompt with Timer, GitHub, Vault or TempFiles integration instructions appended:
    // Keep the user's clean task visible in Arena's chat while hiding /tmp/au_timer, /tmp/au_gh & boilerplate!
    if (/(?:⏱️\s*TIMER OBRIGATÓRIO DE SESSÃO|🐙\s*INTEGRAÇÃO GITHUB|🔐\s*COFRE DE CREDENCIAIS GIT|📦\s*HUB DE ARQUIVOS TEMPORÁRIOS)/i.test(raw)) {
      const idx = raw.search(/\n*\s*(?:⏱️\s*TIMER OBRIGATÓRIO DE SESSÃO|🐙\s*INTEGRAÇÃO GITHUB|🔐\s*COFRE DE CREDENCIAIS GIT|📦\s*HUB DE ARQUIVOS TEMPORÁRIOS)/i);
      if (idx > 0) {
        const cleanSolo = raw.slice(0, idx).trim();
        if (cleanSolo && !SYSTEM_AUTO_PROMPT_ENVELOPE_RX.test(cleanSolo)) {
          return cleanSolo;
        }
      }
    }
    return '';
  }

  global.AU_DEFAULTS = {
    PROMPT_TEMPLATE_VERSION,
    DEFAULT_SETTINGS,
    DEFAULT_PROMPTS,
    DEFAULT_WORKFLOW_MACROS,
    DEFAULT_FOLDERS,
    DEFAULT_METRICS,
    DEFAULT_TOKEN_LIMIT_PATTERNS,
    DEFAULT_CONDITIONAL_RULES,
    COLLAB_PROFILES,
    COLLAB_STOP_MODES,
    TEMP_FILE_PROVIDERS,
    GITHUB_AUTH_MODES,
    GITHUB_AGENT_ACCESS_LEVELS,
    INTEGRATION_STATES,
    GITHUB_BRANCH_MODES,
    PRESET_THEMES,
    normalizeGithubAuthMode,
    normalizePromptKey,
    isSystemOrAutoPromptText,
    extractCleanObjectiveFromAutoPrompt
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
