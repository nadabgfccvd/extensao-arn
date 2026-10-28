(function (global) {
  'use strict';

  const SUPPORTED_LOCALES = ['pt-BR', 'en', 'es'];

  const CATALOGS = {
    'pt-BR': {
      'app.name': 'Arena Ultra',
      'app.tagline': 'Autopilot, Salas Multi-Agent, Cofre Zero-Token & Diff Unificado',
      'action.emergency_stop': '🛑 PARAR TUDO',
      'action.emergency_resume': '▶ Retomar Automação',
      'action.emergency_stopped_toast': '🛑 Todas as automações e salas ativas foram pausadas imediatamente.',
      'action.authorize_and_run': 'Autorizar Escopo & Rodar Autonomamente',
      'action.rebind_tabs': '🔗 Re-vincular Abas desta Sala',
      'action.promote_to_room': '🤝 Transformar Abas em Sala',
      'action.view_diff': 'Δ Diff da Sala',
      'action.export_diag': '📋 Exportar Diagnóstico Sanitizado',
      'nav.overview': 'Visão Geral & Timeline',
      'nav.launcher': 'Multi-Agent & Salas',
      'nav.autopilot': 'Autopilot & Orçamento',
      'nav.scheduler': 'Agendador & Plugins',
      'nav.prompts': 'Prompts & Macros',
      'nav.chats': 'Conversas & Busca Global',
      'nav.integrations': 'Cofre GitHub & Auditoria',
      'nav.themes': 'Temas, Idioma & Acessibilidade',
      'status.running': 'Trabalhando autonomamente',
      'status.waiting_user': '⏸ Aguardando sua escolha no card',
      'status.needs_human': '⚠️ Aguardando decisão objetiva',
      'status.token_stopped': 'Limite de tokens atingido',
      'status.completed': 'Concluído',
      'status.paused': 'Pausado',
      'security.session_only': 'Sessão Volátil (RAM — limpa ao fechar navegador)',
      'security.encrypted_disk': 'Cifrado em Disco (AES-256-GCM + PBKDF2)',
      'security.external_unverified': '⛔ Fonte externa não verificada',
      'security.scope_violation': 'Bloqueado por isolamento de sala (escopo inválido)',
      'consensus.verified': 'Consenso Verificado ({accepted}/{total})',
      'consensus.majority': 'Decisão por Maioria ({accepted}/{total})',
      'diff.no_changes': 'Nenhuma diferença entre snapshots dos Agents ainda.',
      'diff.conflicts_found': '{count} arquivo(s) modificado(s) por múltiplos Agents simultaneamente!'
    },
    'en': {
      'app.name': 'Arena Ultra',
      'app.tagline': 'Autopilot, Multi-Agent Rooms, Zero-Token Vault & Unified Diff',
      'action.emergency_stop': '🛑 STOP ALL',
      'action.emergency_resume': '▶ Resume Automation',
      'action.emergency_stopped_toast': '🛑 All active automations and rooms have been paused immediately.',
      'action.authorize_and_run': 'Authorize Scope & Run Autonomously',
      'action.rebind_tabs': '🔗 Re-bind Tabs for this Room',
      'action.promote_to_room': '🤝 Promote Open Tabs to Room',
      'action.view_diff': 'Δ Room Diff',
      'action.export_diag': '📋 Export Sanitized Diagnostics',
      'nav.overview': 'Overview & Timeline',
      'nav.launcher': 'Multi-Agent & Rooms',
      'nav.autopilot': 'Autopilot & Budget',
      'nav.scheduler': 'Scheduler & Plugins',
      'nav.prompts': 'Prompts & Macros',
      'nav.chats': 'Saved Chats & Global Search',
      'nav.integrations': 'GitHub Vault & Audit Log',
      'nav.themes': 'Themes, Language & Accessibility',
      'status.running': 'Running autonomously',
      'status.waiting_user': '⏸ Waiting for your card selection',
      'status.needs_human': '⚠️ Needs objective human decision',
      'status.token_stopped': 'Token limit reached',
      'status.completed': 'Completed',
      'status.paused': 'Paused',
      'security.session_only': 'Volatile Session (RAM — cleared on browser exit)',
      'security.encrypted_disk': 'Encrypted at Rest (AES-256-GCM + PBKDF2)',
      'security.external_unverified': '⛔ Unverified external source',
      'security.scope_violation': 'Blocked by room isolation (invalid scope)',
      'consensus.verified': 'Verified Consensus ({accepted}/{total})',
      'consensus.majority': 'Majority Decision ({accepted}/{total})',
      'diff.no_changes': 'No file differences captured across Agents yet.',
      'diff.conflicts_found': '{count} file(s) modified concurrently by multiple Agents!'
    },
    'es': {
      'app.name': 'Arena Ultra',
      'app.tagline': 'Autopilot, Salas Multi-Agent, Bóveda Cero-Token y Diff Unificado',
      'action.emergency_stop': '🛑 DETENER TODO',
      'action.emergency_resume': '▶ Reanudar Automatización',
      'action.emergency_stopped_toast': '🛑 Todas las automatizaciones y salas activas fueron pausadas de inmediato.',
      'action.authorize_and_run': 'Autorizar Alcance y Ejecutar',
      'action.rebind_tabs': '🔗 Re-vincular Pestañas de esta Sala',
      'action.promote_to_room': '🤝 Convertir Pestañas en Sala',
      'action.view_diff': 'Δ Diff de Sala',
      'action.export_diag': '📋 Exportar Diagnóstico Sanitizado',
      'nav.overview': 'Resumen y Línea de Tiempo',
      'nav.launcher': 'Multi-Agent y Salas',
      'nav.autopilot': 'Autopilot y Presupuesto',
      'nav.scheduler': 'Programador y Plugins',
      'nav.prompts': 'Prompts y Macros',
      'nav.chats': 'Conversaciones y Búsqueda Global',
      'nav.integrations': 'Bóveda GitHub y Auditoría',
      'nav.themes': 'Temas, Idioma y Accesibilidad',
      'status.running': 'Ejecutando autónomamente',
      'status.waiting_user': '⏸ Esperando tu elección en la tarjeta',
      'status.needs_human': '⚠️ Requiere decisión objetiva',
      'status.token_stopped': 'Límite de tokens alcanzado',
      'status.completed': 'Completado',
      'status.paused': 'En pausa',
      'security.session_only': 'Sesión Volátil (RAM — se borra al cerrar)',
      'security.encrypted_disk': 'Cifrado en Disco (AES-256-GCM + PBKDF2)',
      'security.external_unverified': '⛔ Fuente externa no verificada',
      'security.scope_violation': 'Bloqueado por aislamiento de sala (alcance inválido)',
      'consensus.verified': 'Consenso Verificado ({accepted}/{total})',
      'consensus.majority': 'Decisión por Mayoría ({accepted}/{total})',
      'diff.no_changes': 'Aún no hay diferencias entre snapshots de los Agents.',
      'diff.conflicts_found': '¡{count} archivo(s) modificado(s) por múltiples Agents!'
    }
  };

  let currentLocale = 'pt-BR';

  function normalizeLocale(loc) {
    const raw = String(loc || '').trim();
    if (SUPPORTED_LOCALES.includes(raw)) return raw;
    const lower = raw.toLowerCase();
    if (lower.startsWith('pt')) return 'pt-BR';
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('en')) return 'en';
    return 'pt-BR';
  }

  function setLocale(loc) {
    currentLocale = normalizeLocale(loc);
    return currentLocale;
  }

  function getLocale() {
    return currentLocale;
  }

  function t(key, vars, explicitLocale) {
    const loc = explicitLocale ? normalizeLocale(explicitLocale) : currentLocale;
    const cat = CATALOGS[loc] || CATALOGS['pt-BR'];
    let template = cat[key] !== undefined ? cat[key] : (CATALOGS['pt-BR'][key] !== undefined ? CATALOGS['pt-BR'][key] : String(key));
    if (vars && typeof vars === 'object') {
      template = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) =>
        vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : `{${k}}`
      );
    }
    return template;
  }

  function applyI18nToDocument(doc, explicitLocale) {
    const root = doc || (typeof document !== 'undefined' ? document : null);
    if (!root) return;
    const loc = explicitLocale ? setLocale(explicitLocale) : currentLocale;
    if (root.documentElement) {
      root.documentElement.setAttribute('lang', loc);
    }
    const nodes = root.querySelectorAll('[data-i18n]');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key, null, loc);
    }
    const attrNodes = root.querySelectorAll('[data-i18n-placeholder], [data-i18n-title], [data-i18n-aria]');
    for (let i = 0; i < attrNodes.length; i++) {
      const el = attrNodes[i];
      const ph = el.getAttribute('data-i18n-placeholder');
      if (ph) el.setAttribute('placeholder', t(ph, null, loc));
      const ti = el.getAttribute('data-i18n-title');
      if (ti) el.setAttribute('title', t(ti, null, loc));
      const ar = el.getAttribute('data-i18n-aria');
      if (ar) el.setAttribute('aria-label', t(ar, null, loc));
    }
  }

  global.AU_I18N = {
    SUPPORTED_LOCALES,
    CATALOGS,
    normalizeLocale,
    setLocale,
    getLocale,
    t,
    applyI18nToDocument
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
