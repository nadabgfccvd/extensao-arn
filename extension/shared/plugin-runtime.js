(function (global) {
  'use strict';

  const PLUGINS_KEY = 'au_plugins_v1';

  const SUPPORTED_EVENTS = [
    'on_room_completed',
    'on_pr_opened',
    'on_needs_human',
    'on_agent_message',
    'on_token_limit',
    'on_file_conflict'
  ];

  const DEFAULT_PLUGINS = [
    {
      id: 'plg_conflict_alert',
      name: 'Guardião de Conflitos Multi-Agent',
      description: 'Publica aviso imediato no feed da sala quando 2+ Agents alteram o mesmo arquivo simultaneamente.',
      version: '1.0.0',
      enabled: true,
      event: 'on_file_conflict',
      matchPattern: '',
      actionType: 'append_room_note',
      actionPayload: '⚠️ [Plugin Guardião] Conflito detectado em {{conflictCount}} arquivo(s): {{paths}}. Sincronizem antes do merge!'
    },
    {
      id: 'plg_pr_celebrate',
      name: 'Notificador de Pull Request Aberto',
      description: 'Dispara alerta nativo/webhook sanitizado assim que um Agent abre ou atualiza um PR via Cofre.',
      version: '1.0.0',
      enabled: true,
      event: 'on_pr_opened',
      matchPattern: '',
      actionType: 'notify_and_log',
      actionPayload: '🚀 PR #{{prNumber}} aberto em {{repo}}: {{prUrl}}'
    },
    {
      id: 'plg_auto_tag_security',
      name: 'Auto-Tag de Auditoria & Segurança',
      description: 'Marca conversas/salas que mencionam vulnerabilidades CVE, XSS ou SQLi com a tag "seguranca".',
      version: '1.0.0',
      enabled: true,
      event: 'on_agent_message',
      matchPattern: '\\b(cve-\\d{4}|xss|sqli|csrf|vulnerab)\\b',
      actionType: 'record_audit_tag',
      actionPayload: 'seguranca'
    }
  ];

  function interpolateTemplate(tpl, ctx) {
    return String(tpl || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
      if (!ctx || ctx[k] === undefined || ctx[k] === null) return '';
      const raw = Array.isArray(ctx[k]) ? ctx[k].join(', ') : String(ctx[k]);
      return global.AU_CRED_BROKER ? global.AU_CRED_BROKER.scrubTextSecrets(raw) : raw;
    });
  }

  async function getPlugins() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      return DEFAULT_PLUGINS.slice();
    }
    const res = await new Promise((r) => chrome.storage.local.get(PLUGINS_KEY, (x) => r(x || {})));
    if (!Array.isArray(res[PLUGINS_KEY])) {
      await new Promise((r) => chrome.storage.local.set({ [PLUGINS_KEY]: DEFAULT_PLUGINS }, () => r()));
      return DEFAULT_PLUGINS.slice();
    }
    return res[PLUGINS_KEY].slice();
  }

  async function savePlugins(list) {
    const clean = Array.isArray(list) ? list.slice(0, 40) : [];
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise((r) => chrome.storage.local.set({ [PLUGINS_KEY]: clean }, () => r()));
    }
    return clean;
  }

  async function upsertPlugin(pluginObj) {
    const list = await getPlugins();
    const ev = SUPPORTED_EVENTS.includes(pluginObj && pluginObj.event)
      ? pluginObj.event
      : 'on_room_completed';
    const item = {
      id: (pluginObj && pluginObj.id) || 'plg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: String((pluginObj && pluginObj.name) || 'Novo Plugin').slice(0, 80),
      description: String((pluginObj && pluginObj.description) || '').slice(0, 240),
      version: String((pluginObj && pluginObj.version) || '1.0.0').slice(0, 20),
      enabled: pluginObj && pluginObj.enabled !== undefined ? Boolean(pluginObj.enabled) : true,
      event: ev,
      matchPattern: String((pluginObj && pluginObj.matchPattern) || '').slice(0, 240),
      actionType: String((pluginObj && pluginObj.actionType) || 'notify_and_log'),
      actionPayload: String((pluginObj && pluginObj.actionPayload) || '').slice(0, 1000)
    };
    const idx = list.findIndex((p) => p.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
    await savePlugins(list);
    return item;
  }

  async function deletePlugin(id) {
    const list = await getPlugins();
    const next = list.filter((p) => p.id !== id);
    await savePlugins(next);
    return next;
  }

  // Executes matching plugins with sanitized context (zero access to chrome.* or tokens)
  async function dispatchPluginEvent(eventName, rawContext, actionHandlers) {
    if (!SUPPORTED_EVENTS.includes(eventName)) return [];
    const plugins = await getPlugins();
    const active = plugins.filter((p) => p && p.enabled && p.event === eventName);
    if (!active.length) return [];

    const safeCtx = {};
    if (rawContext && typeof rawContext === 'object') {
      for (const [k, v] of Object.entries(rawContext)) {
        if (/token|secret|password|webhook/i.test(k)) continue;
        safeCtx[k] = v;
      }
    }

    const results = [];
    for (let i = 0; i < active.length; i++) {
      const plg = active[i];
      try {
        if (plg.matchPattern) {
          const rx = new RegExp(plg.matchPattern, 'i');
          const hay = String(safeCtx.text || safeCtx.summary || safeCtx.title || '');
          if (!rx.test(hay)) continue;
        }
        const message = interpolateTemplate(plg.actionPayload, safeCtx);
        if (actionHandlers && typeof actionHandlers[plg.actionType] === 'function') {
          await Promise.race([
            Promise.resolve(actionHandlers[plg.actionType](message, safeCtx, plg)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('plugin_timeout')), 3500))
          ]);
        }
        results.push({ pluginId: plg.id, ok: true, message });
      } catch (err) {
        results.push({ pluginId: plg.id, ok: false, error: String((err && err.message) || err) });
      }
    }
    return results;
  }

  global.AU_PLUGINS = {
    PLUGINS_KEY,
    SUPPORTED_EVENTS,
    DEFAULT_PLUGINS,
    getPlugins,
    savePlugins,
    upsertPlugin,
    deletePlugin,
    dispatchPluginEvent
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
