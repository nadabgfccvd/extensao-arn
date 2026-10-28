(function (global) {
  'use strict';

  const SCHEMA_VERSION = 4;

  const KEYS = {
    SETTINGS: 'au_settings_v1',
    PROMPTS: 'au_prompts_v1',
    MACROS: 'au_macros_v1',
    FOLDERS: 'au_folders_v1',
    CHATS: 'au_saved_chats_v1',
    METRICS: 'au_metrics_v1',
    PRESETS: 'au_room_presets_v1',
    DIAG_LOG: 'au_diag_log_v1',
    REPO_MEMORIES: 'au_repo_memories_v1'
  };

  // Explicit allowlist of non-secret settings keys for disk persistence & backup export (SEC-02, SEC-03)
  const SECRET_SETTING_KEYS = new Set([
    'githubToken',
    'webhookUrl',
    'encryptedGithubTokenBlob',
    'vaultPassphrase'
  ]);

  // In-memory read cache invalidated automatically via rawSet & chrome.storage.onChanged
  const MEM_CACHE = new Map();

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!changes) return;
      if (area === 'session') {
        MEM_CACHE.delete(KEYS.SETTINGS);
        return;
      }
      if (area && area !== 'local') return;
      for (const k of Object.keys(changes)) {
        MEM_CACHE.delete(k);
      }
    });
  }

  function rawGet(keys) {
    return new Promise((resolve) => {
      if (!hasChromeStorage()) {
        const out = {};
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach((k) => {
          try {
            const v = localStorage.getItem(k);
            if (v !== null) out[k] = JSON.parse(v);
          } catch (_) {}
        });
        resolve(out);
        return;
      }
      chrome.storage.local.get(keys, (res) => {
        resolve(res || {});
      });
    });
  }

  function rawSet(obj) {
    for (const k of Object.keys(obj)) {
      MEM_CACHE.delete(k);
    }
    return new Promise((resolve) => {
      if (!hasChromeStorage()) {
        Object.keys(obj).forEach((k) => {
          try {
            localStorage.setItem(k, JSON.stringify(obj[k]));
          } catch (_) {}
        });
        resolve();
        return;
      }
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  function stripSecretsForDiskSettings(settingsObj) {
    const diskCopy = Object.assign({}, settingsObj || {});
    for (const sk of SECRET_SETTING_KEYS) {
      if (sk in diskCopy) delete diskCopy[sk];
    }
    if (global.AU_DEFAULTS && typeof global.AU_DEFAULTS.normalizeGithubAuthMode === 'function') {
      diskCopy.githubAuthMode = global.AU_DEFAULTS.normalizeGithubAuthMode(diskCopy.githubAuthMode);
    }
    return diskCopy;
  }

  async function getSettings() {
    let baseDisk = MEM_CACHE.get(KEYS.SETTINGS);
    if (!baseDisk) {
      const res = await rawGet(KEYS.SETTINGS);
      const saved = res[KEYS.SETTINGS] || {};
      const merged = Object.assign({}, global.AU_DEFAULTS.DEFAULT_SETTINGS, saved);

      let needsSave = false;

      // SEC-01: Coerce retired direct_agent_git mode to vault_broker_zero_token
      const normalizedAuth = global.AU_DEFAULTS.normalizeGithubAuthMode(merged.githubAuthMode);
      if (merged.githubAuthMode !== normalizedAuth) {
        merged.githubAuthMode = normalizedAuth;
        needsSave = true;
      }

      // SEC-02: Migrate any legacy plaintext PAT/webhook out of chrome.storage.local into chrome.storage.session!
      if ((saved.githubToken && String(saved.githubToken).trim()) || (saved.webhookUrl && String(saved.webhookUrl).trim())) {
        if (global.AU_CRED_BROKER) {
          await global.AU_CRED_BROKER.setSessionSecrets({
            githubToken: saved.githubToken || '',
            webhookUrl: saved.webhookUrl || ''
          });
        }
        merged.githubToken = '';
        merged.webhookUrl = '';
        needsSave = true;
      }

      if (!saved.settingsVersion || saved.settingsVersion < 2) {
        const noisyPhrases = new Set([
          'quota exceeded',
          'rate limit exceeded',
          'too many requests',
          'you have reached the limit',
          'usage limit reached',
          'the ai service rejected this request',
          'limite de uso atingido'
        ]);
        merged.tokenLimitPatterns = (merged.tokenLimitPatterns || global.AU_DEFAULTS.DEFAULT_TOKEN_LIMIT_PATTERNS).filter(
          (p) => !noisyPhrases.has(String(p || '').trim().toLowerCase())
        );
        if (!merged.launcherStaggerMs || merged.launcherStaggerMs < 3500) {
          merged.launcherStaggerMs = 4500;
        }
        merged.launcherSequentialWait = true;
        needsSave = true;
      }
      if (!saved.settingsVersion || saved.settingsVersion < 3) {
        const existingRules = Array.isArray(merged.conditionalRules) ? merged.conditionalRules.slice() : [];
        const existingIds = new Set(existingRules.map((r) => r && r.id).filter(Boolean));
        const defaultRules = global.AU_DEFAULTS.DEFAULT_CONDITIONAL_RULES || [];
        const missingDefaults = defaultRules.filter((r) => r && r.id && !existingIds.has(r.id));
        if (missingDefaults.length > 0) {
          merged.conditionalRules = [...missingDefaults, ...existingRules];
        }
        merged.settingsVersion = 3;
        needsSave = true;
      }
      if (!saved.settingsVersion || saved.settingsVersion < 4) {
        const existingPats = Array.isArray(merged.tokenLimitPatterns) ? merged.tokenLimitPatterns.slice() : [];
        const lowerSet = new Set(existingPats.map((p) => String(p || '').toLowerCase().trim()));
        for (const reqPat of ['out of credits', 'no credits remaining', 'credit limit reached', 'sem créditos']) {
          if (!lowerSet.has(reqPat)) {
            existingPats.push(reqPat);
            lowerSet.add(reqPat);
          }
        }
        merged.tokenLimitPatterns = existingPats;
        merged.settingsVersion = 4;
        needsSave = true;
      }
      if (!saved.settingsVersion || saved.settingsVersion < 6) {
        merged.settingsVersion = 6;
        needsSave = true;
      }

      const diskClean = stripSecretsForDiskSettings(merged);
      if (needsSave) {
        await rawSet({ [KEYS.SETTINGS]: diskClean });
      }
      baseDisk = diskClean;
      MEM_CACHE.set(KEYS.SETTINGS, baseDisk);
    }

    // Hydrate volatile secrets from chrome.storage.session in RAM only (never written to storage.local)
    const runtimeSettings = Object.assign({}, baseDisk);
    if (global.AU_CRED_BROKER) {
      const secrets = await global.AU_CRED_BROKER.getSessionSecrets();
      runtimeSettings.githubToken = secrets.githubToken || '';
      runtimeSettings.webhookUrl = secrets.webhookUrl || '';
      runtimeSettings._volatileDegraded = Boolean(secrets.volatileDegraded);
    }
    return runtimeSettings;
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const incoming = Object.assign({}, partial || {});

    if (global.AU_CRED_BROKER && ('githubToken' in incoming || 'webhookUrl' in incoming)) {
      await global.AU_CRED_BROKER.setSessionSecrets({
        githubToken: 'githubToken' in incoming ? incoming.githubToken : current.githubToken,
        webhookUrl: 'webhookUrl' in incoming ? incoming.webhookUrl : current.webhookUrl
      });
    }

    const updated = Object.assign({}, current, incoming);
    updated.githubAuthMode = global.AU_DEFAULTS.normalizeGithubAuthMode(updated.githubAuthMode);
    const diskClean = stripSecretsForDiskSettings(updated);
    await rawSet({ [KEYS.SETTINGS]: diskClean });
    MEM_CACHE.set(KEYS.SETTINGS, diskClean);
    return getSettings();
  }

  async function getPrompts() {
    if (MEM_CACHE.has(KEYS.PROMPTS)) {
      return MEM_CACHE.get(KEYS.PROMPTS).slice();
    }
    const res = await rawGet(KEYS.PROMPTS);
    if (!Array.isArray(res[KEYS.PROMPTS])) {
      await rawSet({ [KEYS.PROMPTS]: global.AU_DEFAULTS.DEFAULT_PROMPTS });
      MEM_CACHE.set(KEYS.PROMPTS, global.AU_DEFAULTS.DEFAULT_PROMPTS);
      return global.AU_DEFAULTS.DEFAULT_PROMPTS.slice();
    }
    MEM_CACHE.set(KEYS.PROMPTS, res[KEYS.PROMPTS]);
    return res[KEYS.PROMPTS].slice();
  }

  async function savePrompts(list) {
    await rawSet({ [KEYS.PROMPTS]: list });
    MEM_CACHE.set(KEYS.PROMPTS, list);
    return list;
  }

  async function upsertPrompt(promptObj) {
    const list = await getPrompts();
    const item = Object.assign(
      {
        id: 'prm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        slash: '',
        title: 'Novo Prompt',
        category: 'Geral',
        favorite: false,
        content: ''
      },
      promptObj
    );
    if (item.slash && !item.slash.startsWith('/')) {
      item.slash = '/' + item.slash.trim();
    }
    const idx = list.findIndex((p) => p.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
    await savePrompts(list);
    return item;
  }

  async function deletePrompt(id) {
    const list = await getPrompts();
    const filtered = list.filter((p) => p.id !== id);
    await savePrompts(filtered);
    return filtered;
  }

  async function getMacros() {
    if (MEM_CACHE.has(KEYS.MACROS)) {
      return MEM_CACHE.get(KEYS.MACROS).slice();
    }
    const res = await rawGet(KEYS.MACROS);
    if (!Array.isArray(res[KEYS.MACROS])) {
      await rawSet({ [KEYS.MACROS]: global.AU_DEFAULTS.DEFAULT_WORKFLOW_MACROS });
      MEM_CACHE.set(KEYS.MACROS, global.AU_DEFAULTS.DEFAULT_WORKFLOW_MACROS);
      return global.AU_DEFAULTS.DEFAULT_WORKFLOW_MACROS.slice();
    }
    MEM_CACHE.set(KEYS.MACROS, res[KEYS.MACROS]);
    return res[KEYS.MACROS].slice();
  }

  async function saveMacros(list) {
    await rawSet({ [KEYS.MACROS]: list });
    MEM_CACHE.set(KEYS.MACROS, list);
    return list;
  }

  async function upsertMacro(macroObj) {
    const list = await getMacros();
    const item = Object.assign(
      {
        id: 'macro_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: 'Nova Macro Agent',
        description: '',
        steps: [],
        loopPromptAfterQueue: global.AU_DEFAULTS.DEFAULT_SETTINGS.fixedContinuePrompt
      },
      macroObj
    );
    const idx = list.findIndex((m) => m.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
    await saveMacros(list);
    return item;
  }

  async function deleteMacro(id) {
    const list = await getMacros();
    const filtered = list.filter((m) => m.id !== id);
    await saveMacros(filtered);
    return filtered;
  }

  async function getFolders() {
    if (MEM_CACHE.has(KEYS.FOLDERS)) {
      return MEM_CACHE.get(KEYS.FOLDERS).slice();
    }
    const res = await rawGet(KEYS.FOLDERS);
    if (!Array.isArray(res[KEYS.FOLDERS])) {
      await rawSet({ [KEYS.FOLDERS]: global.AU_DEFAULTS.DEFAULT_FOLDERS });
      MEM_CACHE.set(KEYS.FOLDERS, global.AU_DEFAULTS.DEFAULT_FOLDERS);
      return global.AU_DEFAULTS.DEFAULT_FOLDERS.slice();
    }
    MEM_CACHE.set(KEYS.FOLDERS, res[KEYS.FOLDERS]);
    return res[KEYS.FOLDERS].slice();
  }

  async function saveFolders(list) {
    await rawSet({ [KEYS.FOLDERS]: list });
    MEM_CACHE.set(KEYS.FOLDERS, list);
    return list;
  }

  // PROD-07: Room Presets & Replay Templates
  const DEFAULT_ROOM_PRESETS = [
    {
      id: 'preset_fullstack_squad',
      name: 'Squad Full-Stack (3 Agents: Arquiteto + Dev + QA/Líder)',
      agentCount: 3,
      collabProfile: 'specialists',
      stopMode: 'smart_consensus',
      githubBranchMode: 'branch_per_agent_pr',
      promptTemplate: 'Construa e valide por completo: {{objetivo}}. Dividam contratos no [QUADRO_UNICO], implementem código real, rodem suíte de testes e consolidem a entrega final.'
    },
    {
      id: 'preset_security_audit',
      name: 'Auditoria de Segurança & Bug-Hunt (3 Agents em Debate)',
      agentCount: 3,
      collabProfile: 'debate_consensus',
      stopMode: 'smart_consensus',
      githubBranchMode: 'branch_per_agent_pr',
      promptTemplate: 'Realizem uma auditoria profunda de segurança, integridade de dados e casos de borda em {{alvo}}, propondo correções verificadas por consenso.'
    }
  ];

  async function getRoomPresets() {
    if (MEM_CACHE.has(KEYS.PRESETS)) {
      return MEM_CACHE.get(KEYS.PRESETS).slice();
    }
    const res = await rawGet(KEYS.PRESETS);
    if (!Array.isArray(res[KEYS.PRESETS])) {
      await rawSet({ [KEYS.PRESETS]: DEFAULT_ROOM_PRESETS });
      MEM_CACHE.set(KEYS.PRESETS, DEFAULT_ROOM_PRESETS);
      return DEFAULT_ROOM_PRESETS.slice();
    }
    MEM_CACHE.set(KEYS.PRESETS, res[KEYS.PRESETS]);
    return res[KEYS.PRESETS].slice();
  }

  async function upsertRoomPreset(presetObj) {
    const list = await getRoomPresets();
    const item = Object.assign(
      {
        id: 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: 'Preset de Sala',
        agentCount: 3,
        collabProfile: 'specialists',
        stopMode: 'smart_consensus',
        githubBranchMode: 'branch_per_agent_pr',
        githubRepo: '',
        promptTemplate: '',
        createdAt: Date.now()
      },
      presetObj || {}
    );
    const idx = list.findIndex((p) => p.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
    const trimmed = list.slice(0, 40);
    await rawSet({ [KEYS.PRESETS]: trimmed });
    MEM_CACHE.set(KEYS.PRESETS, trimmed);
    return item;
  }

  async function deleteRoomPreset(id) {
    const list = await getRoomPresets();
    const next = list.filter((p) => p.id !== id);
    await rawSet({ [KEYS.PRESETS]: next });
    MEM_CACHE.set(KEYS.PRESETS, next);
    return next;
  }

  // UX-04: Structured Sanitized Diagnostics Ring Buffer
  let diagChain = Promise.resolve();
  async function getDiagnostics() {
    const res = await rawGet(KEYS.DIAG_LOG);
    return Array.isArray(res[KEYS.DIAG_LOG]) ? res[KEYS.DIAG_LOG] : [];
  }

  function recordDiagnostic(level, subsystem, message, meta) {
    const op = diagChain.then(async () => {
      const list = await getDiagnostics();
      const scrub = global.AU_CRED_BROKER
        ? global.AU_CRED_BROKER.scrubTextSecrets
        : (s) => String(s || '');
      const entry = {
        id: 'dg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        level: String(level || 'info').slice(0, 16),
        subsystem: scrub(subsystem || 'core').slice(0, 40),
        message: scrub(message || '').slice(0, 400),
        meta: meta ? JSON.parse(scrub(JSON.stringify(meta)).slice(0, 800) || '{}') : undefined
      };
      const next = [entry].concat(list).slice(0, 150);
      await rawSet({ [KEYS.DIAG_LOG]: next });
      return entry;
    });
    diagChain = op.catch(() => {});
    return op;
  }

  async function getSavedChats() {
    if (MEM_CACHE.has(KEYS.CHATS)) {
      return MEM_CACHE.get(KEYS.CHATS).slice();
    }
    const res = await rawGet(KEYS.CHATS);
    const arr = Array.isArray(res[KEYS.CHATS]) ? res[KEYS.CHATS] : [];
    MEM_CACHE.set(KEYS.CHATS, arr);
    return arr.slice();
  }

  function isGenericArenaLandingUrl(rawUrl) {
    if (!rawUrl) return true;
    try {
      const u = new URL(String(rawUrl));
      return /^\/(?:agent|battle|chat)?\/?$/i.test(u.pathname || '/');
    } catch (_) {
      return /^https?:\/\/[^/]+\/(?:agent|battle|chat)?\/?(?:\?.*)?$/i.test(String(rawUrl).trim());
    }
  }

  async function upsertSavedChat(chat) {
    const list = await getSavedChats();
    const now = Date.now();
    const hasSpecificUrl = Boolean(chat.sessionUrl && !isGenericArenaLandingUrl(chat.sessionUrl));
    const sessionKey =
      chat.id ||
      (hasSpecificUrl ? chat.sessionUrl : 'chat_' + now + '_' + Math.random().toString(36).slice(2, 6));
    const idx = list.findIndex(
      (c) => c.id === sessionKey || (hasSpecificUrl && c.sessionUrl === chat.sessionUrl)
    );

    const base = idx >= 0 ? list[idx] : {
      id: sessionKey,
      createdAt: now,
      folderId: chat.mode === 'agent' ? 'fld_agents' : '',
      tags: chat.mode === 'agent' ? ['agent'] : [],
      favorite: false
    };

    const scrub = global.AU_CRED_BROKER
      ? global.AU_CRED_BROKER.scrubTextSecrets
      : (s) => String(s || '');

    const boundedMessages = Array.isArray(chat.messages)
      ? chat.messages.slice(-50).map((m) => ({
          role: m.role || 'assistant',
          ...(m.modelName ? { modelName: String(m.modelName).slice(0, 80) } : {}),
          content: scrub(String(m.content || '')).slice(0, 18000)
        }))
      : base.messages || [];

    const merged = Object.assign({}, base, chat, {
      id: base.id,
      messages: boundedMessages,
      updatedAt: now
    });

    if (idx >= 0) {
      list[idx] = merged;
    } else {
      list.unshift(merged);
    }

    const trimmed = list.slice(0, 120);
    await rawSet({ [KEYS.CHATS]: trimmed });
    MEM_CACHE.set(KEYS.CHATS, trimmed);
    return merged;
  }

  async function deleteSavedChat(id) {
    const list = await getSavedChats();
    const filtered = list.filter((c) => c.id !== id);
    await rawSet({ [KEYS.CHATS]: filtered });
    MEM_CACHE.set(KEYS.CHATS, filtered);
    return filtered;
  }

  let metricsChain = Promise.resolve();

  function cloneMetricsState(src) {
    const base = Object.assign({}, src || {});
    base.sessionLogs = Array.isArray(base.sessionLogs) ? base.sessionLogs.slice() : [];
    base.battleVotes = Array.isArray(base.battleVotes) ? base.battleVotes.slice() : [];
    const notesCopy = {};
    if (base.modelNotes && typeof base.modelNotes === 'object') {
      for (const [k, v] of Object.entries(base.modelNotes)) {
        if (v && typeof v === 'object') notesCopy[k] = Object.assign({}, v);
        else if (v !== undefined) notesCopy[k] = v;
      }
    }
    base.modelNotes = notesCopy;
    return base;
  }

  async function getMetrics() {
    if (MEM_CACHE.has(KEYS.METRICS)) {
      return cloneMetricsState(MEM_CACHE.get(KEYS.METRICS));
    }
    const res = await rawGet(KEYS.METRICS);
    const merged = Object.assign({}, global.AU_DEFAULTS.DEFAULT_METRICS, res[KEYS.METRICS] || {});
    MEM_CACHE.set(KEYS.METRICS, merged);
    return cloneMetricsState(merged);
  }

  function updateMetrics(mutator) {
    const op = metricsChain.then(async () => {
      const current = await getMetrics();
      const next = mutator(cloneMetricsState(current)) || current;
      if (Array.isArray(next.sessionLogs) && next.sessionLogs.length > 200) {
        next.sessionLogs = next.sessionLogs.slice(0, 200);
      }
      if (Array.isArray(next.battleVotes) && next.battleVotes.length > 300) {
        next.battleVotes = next.battleVotes.slice(0, 300);
      }
      await rawSet({ [KEYS.METRICS]: next });
      MEM_CACHE.set(KEYS.METRICS, next);
      return cloneMetricsState(next);
    });
    metricsChain = op.catch(() => {});
    return op;
  }

  async function appendSessionLog(entry) {
    const scrub = global.AU_CRED_BROKER
      ? global.AU_CRED_BROKER.scrubTextSecrets
      : (s) => String(s || '');
    return updateMetrics((m) => {
      const log = Object.assign(
        {
          id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          timestamp: Date.now(),
          tabTitle: 'Arena.ai',
          url: '',
          eventType: 'info',
          loopsCount: 0,
          details: ''
        },
        entry
      );
      log.details = scrub(log.details);
      m.sessionLogs = [log].concat(m.sessionLogs || []);
      return m;
    });
  }

  async function recordBattleVote(vote) {
    return updateMetrics((m) => {
      const item = Object.assign(
        {
          id: 'vote_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          timestamp: Date.now(),
          winner: 'tie',
          modelA: 'Modelo A',
          modelB: 'Modelo B',
          promptSnippet: '',
          latencyMs: Number((vote && vote.latencyMs) || 0)
        },
        vote
      );
      m.battleVotes = [item].concat(m.battleVotes || []);
      m.modelNotes = m.modelNotes || {};

      const ensureModel = (name) => {
        if (!name || name === 'Modelo A' || name === 'Modelo B') return null;
        if (!m.modelNotes[name]) {
          m.modelNotes[name] = { wins: 0, losses: 0, ties: 0, notes: '', runs: 0, avgLatencyMs: 0 };
        }
        return m.modelNotes[name];
      };

      const recA = ensureModel(item.modelA);
      const recB = ensureModel(item.modelB);
      if (item.winner === 'modelA') {
        if (recA) recA.wins += 1;
        if (recB) recB.losses += 1;
      } else if (item.winner === 'modelB') {
        if (recB) recB.wins += 1;
        if (recA) recA.losses += 1;
      } else if (item.winner === 'tie') {
        if (recA) recA.ties += 1;
        if (recB) recB.ties += 1;
      }
      return m;
    });
  }

  function estimateTokens(text) {
    if (!text) return 0;
    const clean = String(text).trim();
    if (!clean) return 0;
    return Math.max(1, Math.ceil(clean.length / 3.8));
  }

  function extractVariables(template) {
    if (!template) return [];
    const regex = /\{\{\s*([a-zA-Z0-9_À-ÿ-]+)\s*\}\}/g;
    const found = [];
    let match;
    while ((match = regex.exec(template)) !== null) {
      const name = match[1].trim();
      if (!found.includes(name)) found.push(name);
    }
    return found;
  }

  function fillVariables(template, values) {
    if (!template) return '';
    return String(template).replace(/\{\{\s*([a-zA-Z0-9_À-ÿ-]+)\s*\}\}/g, (_, key) => {
      const k = key.trim();
      return values && values[k] !== undefined && values[k] !== '' ? values[k] : `{{${k}}}`;
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeXml(str) {
    return String(str || '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // PROD-11: Markdown with Obsidian YAML Front-Matter
  function formatChatAsMarkdown(chat, opts) {
    const withFrontmatter = !opts || opts.frontmatter !== false;
    const isoDate = new Date(chat.updatedAt || Date.now()).toISOString();
    const dateStr = new Date(chat.updatedAt || Date.now()).toLocaleString('pt-BR');
    const tags = Array.isArray(chat.tags) ? chat.tags : [];
    const fm = withFrontmatter
      ? [
          '---',
          `title: "${String(chat.title || 'Conversa Arena.ai').replace(/"/g, '\\"')}"`,
          `source_url: "${String(chat.sessionUrl || 'https://arena.ai').replace(/"/g, '\\"')}"`,
          `mode: "${String(chat.mode || 'chat')}"`,
          `updated_at: "${isoDate}"`,
          `auto_loops: ${Number(chat.loopsCount || 0)}`,
          `tags: [${tags.map((t) => `"${String(t).replace(/"/g, '\\"')}"`).join(', ')}]`,
          'generator: "Arena Ultra v4.0.0"',
          '---',
          ''
        ]
      : [];

    const lines = fm.concat([
      `# ${chat.title || 'Conversa Arena.ai'}`,
      '',
      `- **URL:** ${chat.sessionUrl || 'https://arena.ai'}`,
      `- **Modo:** ${(chat.mode || 'chat').toUpperCase()}`,
      `- **Data:** ${dateStr}`,
      `- **Loops Automáticos:** ${chat.loopsCount || 0}`,
      `- **Tags:** ${tags.join(', ') || 'Nenhuma'}`,
      '',
      '---',
      ''
    ]);
    (chat.messages || []).forEach((msg, idx) => {
      const roleLabel = msg.role === 'user' ? 'Você' : (msg.modelName || 'Arena AI / Agent');
      lines.push(`### ${idx + 1}. ${roleLabel}`);
      lines.push('');
      lines.push(msg.content || '');
      lines.push('');
      lines.push('---');
      lines.push('');
    });
    return lines.join('\n');
  }

  // PROD-11: Executive Summary Markdown
  function formatChatAsExecutiveSummary(chat) {
    const msgs = Array.isArray(chat.messages) ? chat.messages : [];
    const userMsgs = msgs.filter((m) => m.role === 'user');
    const aiMsgs = msgs.filter((m) => m.role !== 'user');
    const models = Array.from(new Set(aiMsgs.map((m) => m.modelName).filter(Boolean)));
    const firstObjective = userMsgs[0] ? String(userMsgs[0].content || '').slice(0, 600) : '(Não registrado)';
    const finalOutcome = aiMsgs.length
      ? String(aiMsgs[aiMsgs.length - 1].content || '').slice(0, 2200)
      : '(Sem resposta final)';

    return [
      `# Resumo Executivo — ${chat.title || 'Sessão Arena.ai'}`,
      '',
      `- **Modo:** ${(chat.mode || 'agent').toUpperCase()}`,
      `- **Modelos Identificados:** ${models.join(', ') || 'Arena Agent'}`,
      `- **Total de Turnos:** ${msgs.length} (${userMsgs.length} prompts, ${aiMsgs.length} respostas)`,
      `- **Loops Autônomos:** ${Number(chat.loopsCount || 0)}`,
      '',
      '## 1. Objetivo Inicial',
      firstObjective,
      '',
      '## 2. Resultado / Entrega Mais Recente',
      finalOutcome,
      ''
    ].join('\n');
  }

  // PROD-11: Print-ready HTML/PDF (@page A4 rules, zero inline script for strict CSP)
  function formatChatAsHtml(chat) {
    const dateStr = new Date(chat.updatedAt || Date.now()).toLocaleString('pt-BR');
    const msgsHtml = (chat.messages || [])
      .map((msg) => {
        const isUser = msg.role === 'user';
        const roleLabel = isUser ? 'Você' : escapeHtml(msg.modelName || 'Arena AI / Agent');
        const formattedText = escapeHtml(msg.content || '').replace(
          /```([\s\S]*?)```/g,
          '<pre><code>$1</code></pre>'
        );
        return `
          <div class="msg ${isUser ? 'msg-user' : 'msg-ai'}">
            <div class="msg-role">${roleLabel}</div>
            <div class="msg-body">${formattedText}</div>
          </div>
        `;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(chat.title || 'Conversa Arena.ai')}</title>
  <style>
    @page { size: A4; margin: 18mm 15mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 860px; margin: 32px auto; padding: 0 24px; color: #18181b; line-height: 1.6; background: #fff; }
    header { border-bottom: 2px solid #18181b; padding-bottom: 14px; margin-bottom: 24px; }
    h1 { font-size: 22px; margin: 0 0 8px 0; }
    .meta { font-size: 12.5px; color: #52525b; display: flex; gap: 16px; flex-wrap: wrap; }
    .print-hint { font-size: 12.5px; background: #f4f4f5; border: 1px solid #d4d4d8; padding: 8px 12px; border-radius: 8px; margin-bottom: 18px; }
    .msg { border: 1px solid #e4e4e7; border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; break-inside: avoid; page-break-inside: avoid; }
    .msg-user { background: #f8fafc; border-color: #cbd5e1; }
    .msg-ai { background: #ffffff; }
    .msg-role { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #3f3f46; margin-bottom: 6px; }
    .msg-body { white-space: pre-wrap; font-size: 13.5px; word-break: break-word; }
    pre { background: #0f172a; color: #f8fafc; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
    @media print { body { margin: 0; padding: 0; max-width: none; } .no-print { display: none !important; } }
  </style>
</head>
<body>
  <div class="no-print print-hint">Pressione <strong>Ctrl+P</strong> (ou <strong>Cmd+P</strong>) e escolha <em>Salvar como PDF</em> para gerar PDF paginado em A4.</div>
  <header>
    <h1>${escapeHtml(chat.title || 'Conversa Arena.ai')}</h1>
    <div class="meta">
      <span><strong>Modo:</strong> ${escapeHtml((chat.mode || 'chat').toUpperCase())}</span>
      <span><strong>Data:</strong> ${escapeHtml(dateStr)}</span>
      <span><strong>Loops Agent:</strong> ${Number(chat.loopsCount || 0)}</span>
      <span><strong>URL:</strong> ${escapeHtml(chat.sessionUrl || 'https://arena.ai')}</span>
    </div>
  </header>
  <main>${msgsHtml}</main>
</body>
</html>`;
  }

  // PROD-11: Genuine OOXML .docx Generator using AU_INTEGRATIONS.buildZipArchive
  function buildChatDocxBytes(chat) {
    if (!global.AU_INTEGRATIONS || typeof global.AU_INTEGRATIONS.buildZipArchive !== 'function') {
      throw new Error('Módulo ZIP (AU_INTEGRATIONS.buildZipArchive) indisponível.');
    }
    const title = String(chat.title || 'Conversa Arena.ai');
    const dateStr = new Date(chat.updatedAt || Date.now()).toLocaleString('pt-BR');
    const paragraphs = [];

    const makePara = (text, styleId, bold) => {
      const safe = escapeXml(text);
      const pPr = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : '';
      const rPr = bold ? '<w:rPr><w:b/></w:rPr>' : '';
      return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
    };

    paragraphs.push(makePara(title, 'Heading1', true));
    paragraphs.push(
      makePara(
        `Modo: ${(chat.mode || 'chat').toUpperCase()}  |  Data: ${dateStr}  |  Loops: ${Number(chat.loopsCount || 0)}  |  URL: ${chat.sessionUrl || 'https://arena.ai'}`,
        'Subtitle',
        false
      )
    );

    const msgs = Array.isArray(chat.messages) ? chat.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const speaker = m.role === 'user' ? 'Você' : (m.modelName || 'Arena AI / Agent');
      paragraphs.push(makePara(`${i + 1}. ${speaker}`, 'Heading2', true));
      const lines = String(m.content || '').replace(/\r\n/g, '\n').split('\n');
      for (let l = 0; l < lines.length; l++) {
        paragraphs.push(makePara(lines[l], '', false));
      }
    }

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="34"/><w:color w:val="111827"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:spacing w:before="200" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="25"/><w:color w:val="059669"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/>
    <w:pPr><w:spacing w:after="180"/></w:pPr>
    <w:rPr><w:i/><w:sz w:val="19"/><w:color w:val="6B7280"/></w:rPr>
  </w:style>
</w:styles>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    return global.AU_INTEGRATIONS.buildZipArchive([
      { path: '[Content_Types].xml', text: contentTypesXml },
      { path: '_rels/.rels', text: rootRelsXml },
      { path: 'word/_rels/document.xml.rels', text: docRelsXml },
      { path: 'word/styles.xml', text: stylesXml },
      { path: 'word/document.xml', text: documentXml }
    ]);
  }

  // PROD-02: Global Search across Saved Chats, Prompts, Macros, Rooms, Workspaces & Diagnostics
  async function searchGlobalIndex(rawQuery, extraContext) {
    const q = String(rawQuery || '').trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const matchesAll = (text) => {
      const hay = String(text || '').toLowerCase();
      for (let i = 0; i < tokens.length; i++) {
        if (!hay.includes(tokens[i])) return false;
      }
      return true;
    };

    const [chats, prompts, macros, presets, diags] = await Promise.all([
      getSavedChats(),
      getPrompts(),
      getMacros(),
      getRoomPresets(),
      getDiagnostics()
    ]);

    const results = [];

    for (let i = 0; i < chats.length; i++) {
      const c = chats[i];
      const msgText = (c.messages || []).map((m) => m.content || '').join('\n');
      const combined = `${c.title || ''} ${(c.tags || []).join(' ')} ${msgText}`;
      if (matchesAll(combined)) {
        results.push({
          type: 'chat',
          id: c.id,
          title: c.title || 'Conversa Salva',
          subtitle: `${(c.mode || 'chat').toUpperCase()} • ${new Date(c.updatedAt || Date.now()).toLocaleDateString('pt-BR')}`,
          snippet: msgText.slice(0, 180),
          url: c.sessionUrl || ''
        });
      }
    }

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      if (matchesAll(`${p.title} ${p.slash} ${p.category} ${p.content}`)) {
        results.push({
          type: 'prompt',
          id: p.id,
          title: `${p.slash || ''} ${p.title}`.trim(),
          subtitle: `Prompt • ${p.category || 'Geral'}`,
          snippet: String(p.content || '').slice(0, 180)
        });
      }
    }

    for (let i = 0; i < macros.length; i++) {
      const m = macros[i];
      const stepsStr = (m.steps || []).join(' ');
      if (matchesAll(`${m.name} ${m.description} ${stepsStr}`)) {
        results.push({
          type: 'macro',
          id: m.id,
          title: m.name,
          subtitle: `Macro • ${(m.steps || []).length} etapa(s)`,
          snippet: m.description || stepsStr.slice(0, 180)
        });
      }
    }

    const rooms = (extraContext && Array.isArray(extraContext.rooms)) ? extraContext.rooms : [];
    for (let r = 0; r < rooms.length; r++) {
      const rm = rooms[r];
      const msgHay = (rm.messages || []).map((m) => `${m.author || ''}: ${m.text || ''}`).join('\n');
      const snapPaths = Array.isArray(rm.workspaceSnapshots)
        ? rm.workspaceSnapshots.flatMap((s) => (s.files || []).map((f) => `${f.path}\n${(f.text || '').slice(0, 1500)}`)).join('\n')
        : '';
      if (matchesAll(`#${rm.roomId} ${rm.objective || ''} ${rm.githubRepo || ''} ${msgHay} ${snapPaths}`)) {
        results.push({
          type: 'room',
          id: rm.roomId,
          title: `Sala #${rm.roomId} — ${String(rm.objective || '').slice(0, 60)}`,
          subtitle: `Sala Multi-Agent • Status: ${rm.status || 'active'}`,
          snippet: (msgHay || snapPaths || rm.objective || '').slice(0, 180)
        });
      }
    }

    for (let i = 0; i < presets.length; i++) {
      const pr = presets[i];
      if (matchesAll(`${pr.name} ${pr.promptTemplate}`)) {
        results.push({
          type: 'preset',
          id: pr.id,
          title: pr.name,
          subtitle: `Preset de Sala • ${pr.agentCount} Agents`,
          snippet: String(pr.promptTemplate || '').slice(0, 180)
        });
      }
    }

    for (let i = 0; i < diags.length; i++) {
      const d = diags[i];
      if (matchesAll(`${d.subsystem} ${d.level} ${d.message}`)) {
        results.push({
          type: 'diagnostic',
          id: d.id,
          title: `[${String(d.level).toUpperCase()}] ${d.subsystem}`,
          subtitle: new Date(d.ts).toLocaleString('pt-BR'),
          snippet: d.message
        });
      }
    }

    return results.slice(0, 80);
  }

  // SEC-03: Export All Data with Strict Secret Allowlist & Deep Redaction
  async function exportAllData() {
    const [rawSettings, prompts, macros, folders, chats, metrics, presets] = await Promise.all([
      getSettings(),
      getPrompts(),
      getMacros(),
      getFolders(),
      getSavedChats(),
      getMetrics(),
      getRoomPresets()
    ]);

    const safeSettings = stripSecretsForDiskSettings(rawSettings);
    const scrub = global.AU_CRED_BROKER
      ? global.AU_CRED_BROKER.scrubTextSecrets
      : (s) => String(s || '');

    const extVer =
      (typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getManifest === 'function' &&
        chrome.runtime.getManifest().version) ||
      '4.0.0';

    const payload = {
      extension: 'Arena Ultra',
      version: extVer,
      schemaVersion: SCHEMA_VERSION,
      secretsOmitted: true,
      exportedAt: new Date().toISOString(),
      settings: safeSettings,
      prompts,
      macros,
      folders,
      presets,
      chats,
      metrics
    };

    // Deep scrub pass ensuring zero sentinel or token strings ever leave exportAllData()
    return JSON.parse(scrub(JSON.stringify(payload)));
  }

  // SEC-03 & ENG-06: Import All Data ignoring secret keys & migrating older schemas
  async function importAllData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Arquivo JSON inválido.');
    }
    const batch = {};
    if (payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)) {
      const incomingSafe = stripSecretsForDiskSettings(payload.settings);
      batch[KEYS.SETTINGS] = Object.assign({}, global.AU_DEFAULTS.DEFAULT_SETTINGS, incomingSafe, {
        settingsVersion: Number(payload.settings.settingsVersion || 0)
      });
    }
    if (Array.isArray(payload.prompts)) batch[KEYS.PROMPTS] = payload.prompts;
    if (Array.isArray(payload.macros)) batch[KEYS.MACROS] = payload.macros;
    if (Array.isArray(payload.folders)) batch[KEYS.FOLDERS] = payload.folders;
    if (Array.isArray(payload.presets)) batch[KEYS.PRESETS] = payload.presets;
    if (Array.isArray(payload.chats)) batch[KEYS.CHATS] = payload.chats;
    if (payload.metrics && typeof payload.metrics === 'object' && !Array.isArray(payload.metrics)) {
      batch[KEYS.METRICS] = Object.assign({}, global.AU_DEFAULTS.DEFAULT_METRICS, payload.metrics);
    }
    if (Object.keys(batch).length === 0) {
      throw new Error('Este arquivo JSON não contém um backup válido do Arena Ultra.');
    }
    await rawSet(batch);
    if (payload.settings) {
      await getSettings();
    }
    return true;
  }

  async function exportSanitizedDiagnosticReport(extraRuntimeInfo) {
    const [settings, metrics, diags] = await Promise.all([
      getSettings(),
      getMetrics(),
      getDiagnostics()
    ]);
    const secAudit = global.AU_CRED_BROKER
      ? await global.AU_CRED_BROKER.getSecurityAuditLog()
      : [];
    const scrub = global.AU_CRED_BROKER
      ? global.AU_CRED_BROKER.scrubTextSecrets
      : (s) => String(s || '');

    const report = {
      generatedAt: new Date().toISOString(),
      extensionVersion:
        (typeof chrome !== 'undefined' &&
          chrome.runtime &&
          typeof chrome.runtime.getManifest === 'function' &&
          chrome.runtime.getManifest().version) ||
        '4.0.0',
      schemaVersion: SCHEMA_VERSION,
      secretsOmitted: true,
      volatileSessionDegraded: Boolean(settings._volatileDegraded),
      safeSettingsSummary: {
        locale: settings.locale,
        githubAuthMode: settings.githubAuthMode,
        taskPolicyMode: settings.taskPolicyMode,
        refuseThinkingModels: settings.refuseThinkingModels,
        emergencyStopActive: settings.emergencyStopActive
      },
      metricsSummary: {
        totalAutoLoopsSent: metrics.totalAutoLoopsSent,
        totalCollabRoomsCreated: metrics.totalCollabRoomsCreated,
        totalGithubCommitsPushed: metrics.totalGithubCommitsPushed,
        totalGithubPRsCreated: metrics.totalGithubPRsCreated,
        totalTokenLimitStops: metrics.totalTokenLimitStops
      },
      runtime: extraRuntimeInfo || {},
      recentDiagnostics: diags.slice(0, 60),
      recentSecurityAudit: secAudit.slice(0, 60)
    };
    return JSON.parse(scrub(JSON.stringify(report)));
  }

  // PROD-04: Persistent Codebase Memory & Incremental Briefing per Repository
  function normalizeRepoSlugKey(repoSlug) {
    return String(repoSlug || '')
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
  }

  async function listRepoMemories() {
    const res = await rawGet(KEYS.REPO_MEMORIES);
    const raw = res && res[KEYS.REPO_MEMORIES];
    return raw && typeof raw === 'object' ? raw : {};
  }

  async function getRepoMemory(repoSlug) {
    const key = normalizeRepoSlugKey(repoSlug);
    if (!key) return null;
    const all = await listRepoMemories();
    return all[key] || null;
  }

  async function saveRepoMemory(repoSlug, patch = {}) {
    const key = normalizeRepoSlugKey(repoSlug);
    if (!key) return null;
    const scrub =
      global.AU_CRED_BROKER && typeof global.AU_CRED_BROKER.scrubTextSecrets === 'function'
        ? global.AU_CRED_BROKER.scrubTextSecrets
        : (s) => String(s || '');
    const all = Object.assign({}, await listRepoMemories());
    const prev = all[key] || { repo: key, createdAt: Date.now() };
    const archRaw =
      patch.architectureSummary !== undefined
        ? patch.architectureSummary
        : patch.architecture !== undefined
          ? patch.architecture
          : prev.architectureSummary || '';
    const convInput =
      patch.conventions !== undefined
        ? Array.isArray(patch.conventions)
          ? patch.conventions.join(', ')
          : patch.conventions
        : prev.conventions || '';
    const next = {
      repo: key,
      createdAt: prev.createdAt || Date.now(),
      updatedAt: Date.now(),
      architectureSummary: scrub(archRaw).slice(0, 2200),
      architecture: scrub(archRaw).slice(0, 2200),
      conventions: scrub(convInput).slice(0, 1400),
      decisionsLog: Array.isArray(patch.decisionsLog)
        ? patch.decisionsLog.map((d) => scrub(d).slice(0, 300)).slice(-20)
        : Array.isArray(prev.decisionsLog)
          ? prev.decisionsLog
          : []
    };
    all[key] = next;
    await rawSet({ [KEYS.REPO_MEMORIES]: all });
    return next;
  }

  async function runSchemaMigrations() {
    // getSettings() runs in-place v3 -> v4 schema cleaning & secret scrubbing automatically
    const s = await getSettings();
    return { ok: true, schemaVersion: SCHEMA_VERSION, settingsVersion: s.settingsVersion };
  }

  global.AU_STORAGE = {
    SCHEMA_VERSION,
    KEYS,
    SECRET_SETTING_KEYS,
    getSettings,
    saveSettings,
    getPrompts,
    savePrompts,
    upsertPrompt,
    deletePrompt,
    getMacros,
    saveMacros,
    upsertMacro,
    deleteMacro,
    getFolders,
    saveFolders,
    getRoomPresets,
    upsertRoomPreset,
    deleteRoomPreset,
    getDiagnostics,
    recordDiagnostic,
    getSavedChats,
    upsertSavedChat,
    deleteSavedChat,
    getMetrics,
    updateMetrics,
    appendSessionLog,
    recordBattleVote,
    estimateTokens,
    extractVariables,
    fillVariables,
    escapeHtml,
    formatChatAsMarkdown,
    formatChatAsExecutiveSummary,
    formatChatAsHtml,
    buildChatDocxBytes,
    searchGlobalIndex,
    exportAllData,
    importAllData,
    exportSanitizedDiagnosticReport,
    listRepoMemories,
    getRepoMemory,
    saveRepoMemory,
    runSchemaMigrations
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
