/* global importScripts, AU_I18N, AU_CRED_BROKER, AU_DIFF, AU_ARENA_ADAPTER, AU_SCHEDULER, AU_PLUGINS, AU_DEFAULTS, AU_STORAGE, AU_INTEGRATIONS, AU_COLLAB */
importScripts(
  '../shared/i18n.js',
  '../shared/cred-broker.js',
  '../shared/diff-engine.js',
  '../shared/arena-adapter.js',
  '../shared/scheduler.js',
  '../shared/plugin-runtime.js',
  '../shared/defaults.js',
  '../shared/storage.js',
  '../shared/integrations.js',
  '../shared/agent-kit.js',
  '../shared/harness-engine.js',
  '../shared/collab-engine.js'
);

const TAB_STATES = new Map();       // tabId -> state object (SW-authoritative for collabRoomId & collabBindingEpoch!)
const PENDING_JOBS = new Map();     // tabId -> { initialPrompt, autoEnableLoop, queue, fixedPrompt, strategy, createdAt }
const SLOT_INITIAL_PROMPTS = new Map(); // tabId -> ephemeral initialPrompt string (kept in memory + session storage for anti-thinking re-rolls)
const PENDING_ARCHIVE_IDS = new Set();  // convIds whose archive did not confirm before page reload (retried automatically on next /agent load!)
const ROOM_GITHUB_TOKENS = new Map();   // roomId -> ephemeral PAT string in session memory
const ROOM_VAULT_CAPS = new Map();      // roomId -> { ag1: 'aucap_...', ... } capability nonces (session RAM only!)
let SESSION_GLOBAL_GITHUB_TOKEN = '';   // SEC-02 / ARENA-16: Volatile PAT mirrored strictly in RAM + chrome.storage.session
let SESSION_WEBHOOK_URL = '';           // SEC-02: Volatile Webhook URL mirrored strictly in RAM + chrome.storage.session
let VAULT_CREDENTIAL_META = {           // Sealed Vault session metadata (session RAM + chrome.storage.session)
  storedAt: 0,
  revokedAt: 0,
  sessionUnavailable: false,
  lastHealth: null
};
const LAST_TAB_GH_PUSH_SIG = new Map(); // tabId -> signature of last auto-pushed GitHub payload (prevents duplicate commits)
const ACTIVE_PORTS = new Map();     // tabId -> chrome.runtime.Port
const COLLAB_ROOMS = new Map();     // roomId (4-digit) -> room object
const EXT_TAB_TO_ROOM = new Map();  // tempchat.online tabId -> roomId
const EXT_TAB_BINDING_TOKENS = new Map(); // tempchat.online tabId -> CSPRNG bindingToken (ARENA-18)
const TAB_BINDING_EPOCHS = new Map();     // tabId -> monotonic bindingEpoch integer (ARENA-18)
let lastRerollNavAt = 0;
let rerollChain = Promise.resolve();
let volatileWorkerStateLoaded = false;

function getSessionStoreArea() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return chrome.storage.session || chrome.storage.local || null;
  }
  return null;
}

function getStrictSessionOnlyArea() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
    return chrome.storage.session;
  }
  return null;
}

function persistVolatileWorkerState() {
  const area = getSessionStoreArea();
  const now = Date.now();
  if (area) {
    try {
      const archiveArr = Array.from(PENDING_ARCHIVE_IDS).slice(-35);
      const slotPromptsObj = {};
      let count = 0;
      for (const [tid, prm] of SLOT_INITIAL_PROMPTS.entries()) {
        if (count >= 25) break;
        if (tid && prm) {
          slotPromptsObj[String(tid)] = String(prm).slice(0, 24000);
          count += 1;
        }
      }
      const pendingJobsObj = {};
      let jobCount = 0;
      for (const [tid, job] of PENDING_JOBS.entries()) {
        if (jobCount >= 18) break;
        if (tid && job && now - (job.createdAt || 0) <= 120000) {
          pendingJobsObj[String(tid)] = job;
          jobCount += 1;
        }
      }
      area.set(
        {
          au_volatile_worker_v1: {
            archiveIds: archiveArr,
            slotPrompts: slotPromptsObj,
            pendingJobs: pendingJobsObj
          }
        },
        () => {
          if (chrome.runtime) void chrome.runtime.lastError;
        }
      );
    } catch (_) {}
  }

  // Ephemeral per-room GitHub PATs + Vault Nonces are stored STRICTLY in RAM-backed chrome.storage.session (never on disk!)
  const sessionOnly = getStrictSessionOnlyArea();
  if (sessionOnly) {
    try {
      const roomTokensObj = {};
      for (const [rid, tok] of ROOM_GITHUB_TOKENS.entries()) {
        if (rid && tok) roomTokensObj[String(rid)] = String(tok);
      }
      const roomCapsObj = {};
      for (const [rid, caps] of ROOM_VAULT_CAPS.entries()) {
        if (rid && caps && typeof caps === 'object') roomCapsObj[String(rid)] = caps;
      }
      sessionOnly.set(
        {
          au_ephemeral_room_tokens_v1: roomTokensObj,
          au_ephemeral_vault_caps_v1: roomCapsObj,
          au_vault_credential_meta_v1: VAULT_CREDENTIAL_META
        },
        () => {
          if (chrome.runtime) void chrome.runtime.lastError;
        }
      );
    } catch (_) {}
  }
}

async function ensureVolatileWorkerStateLoaded() {
  if (volatileWorkerStateLoaded) return;
  volatileWorkerStateLoaded = true;
  const area = getSessionStoreArea();
  const now = Date.now();
  if (area) {
    await new Promise((resolve) => {
      try {
        area.get('au_volatile_worker_v1', (res) => {
          if (chrome.runtime) void chrome.runtime.lastError;
          const data = res && res.au_volatile_worker_v1;
          if (data) {
            if (Array.isArray(data.archiveIds)) {
              data.archiveIds.forEach((id) => {
                if (id) PENDING_ARCHIVE_IDS.add(String(id));
              });
            }
            if (data.slotPrompts && typeof data.slotPrompts === 'object') {
              for (const [k, v] of Object.entries(data.slotPrompts)) {
                const numId = Number(k);
                if (numId && v && !SLOT_INITIAL_PROMPTS.has(numId)) {
                  SLOT_INITIAL_PROMPTS.set(numId, String(v));
                }
              }
            }
            if (data.pendingJobs && typeof data.pendingJobs === 'object') {
              for (const [k, job] of Object.entries(data.pendingJobs)) {
                const numId = Number(k);
                if (numId && job && typeof job === 'object' && now - (job.createdAt || 0) <= 120000 && !PENDING_JOBS.has(numId)) {
                  PENDING_JOBS.set(numId, job);
                }
              }
            }
          }
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  const sessionOnly = getStrictSessionOnlyArea();
  if (sessionOnly) {
    await new Promise((resolve) => {
      try {
        sessionOnly.get(
          ['au_ephemeral_room_tokens_v1', 'au_ephemeral_vault_caps_v1', 'au_vault_credential_meta_v1'],
          (res) => {
            if (chrome.runtime) void chrome.runtime.lastError;
            const mapObj = res && res.au_ephemeral_room_tokens_v1;
            if (mapObj && typeof mapObj === 'object') {
              for (const [rid, tok] of Object.entries(mapObj)) {
                if (rid && tok && !ROOM_GITHUB_TOKENS.has(rid)) {
                  ROOM_GITHUB_TOKENS.set(String(rid), String(tok));
                }
              }
            }
            const capsObj = res && res.au_ephemeral_vault_caps_v1;
            if (capsObj && typeof capsObj === 'object') {
              for (const [rid, caps] of Object.entries(capsObj)) {
                if (rid && caps && typeof caps === 'object' && !ROOM_VAULT_CAPS.has(rid)) {
                  ROOM_VAULT_CAPS.set(String(rid), caps);
                }
              }
            }
            if (res && res.au_vault_credential_meta_v1 && typeof res.au_vault_credential_meta_v1 === 'object') {
              VAULT_CREDENTIAL_META = Object.assign({}, VAULT_CREDENTIAL_META, res.au_vault_credential_meta_v1);
            }
            resolve();
          }
        );
      } catch (_) {
        resolve();
      }
    });
  } else {
    // ARENA-16: Never fall back silently to storage.local for secrets — mark sessionUnavailable explicitly!
    VAULT_CREDENTIAL_META.sessionUnavailable = true;
  }

  // SEC-02: Hydrate RAM mirror from volatile storage.session (and run one-time legacy settings migration if needed)
  try {
    await AU_STORAGE.getSettings(); // triggers schema v4 migration stripping any legacy plaintext PAT into storage.session
    if (AU_STORAGE.isSessionVaultAvailable && AU_STORAGE.isSessionVaultAvailable()) {
      const sTok = await AU_STORAGE.getSessionSecret('githubToken');
      if (sTok) {
        SESSION_GLOBAL_GITHUB_TOKEN = AU_INTEGRATIONS.normalizeGithubToken(sTok);
        if (typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.registerKnownSecret) {
          AU_CRED_BROKER.registerKnownSecret(SESSION_GLOBAL_GITHUB_TOKEN);
        }
      }
      const sWh = await AU_STORAGE.getSessionSecret('webhookUrl');
      if (sWh) {
        SESSION_WEBHOOK_URL = String(sWh).trim();
        if (typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.registerKnownSecret) {
          AU_CRED_BROKER.registerKnownSecret(SESSION_WEBHOOK_URL);
        }
      }
    }
  } catch (_) {}
}

// SEC-02 + ARENA-16: Store global PAT strictly in RAM + chrome.storage.session (NEVER in chrome.storage.local plaintext!)
async function setGlobalVaultToken(rawToken) {
  const clean = AU_INTEGRATIONS.normalizeGithubToken(rawToken || '');
  SESSION_GLOBAL_GITHUB_TOKEN = clean;
  if (clean && typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.registerKnownSecret) {
    AU_CRED_BROKER.registerKnownSecret(clean);
  }
  if (clean) {
    VAULT_CREDENTIAL_META.storedAt = Date.now();
    VAULT_CREDENTIAL_META.revokedAt = 0;
  }
  persistVolatileWorkerState();
  if (AU_STORAGE.isSessionVaultAvailable && AU_STORAGE.isSessionVaultAvailable()) {
    await AU_STORAGE.setSessionSecret('githubToken', clean);
    return { ok: true, persistedInSession: true, sessionUnavailable: false };
  }
  VAULT_CREDENTIAL_META.sessionUnavailable = true;
  return {
    ok: true,
    persistedInSession: false,
    sessionUnavailable: true,
    warning: 'chrome.storage.session indisponível neste navegador — token mantido apenas em RAM volátil (nunca em disco).'
  };
}

async function setGlobalWebhookSecret(rawUrl) {
  const clean = String(rawUrl || '').trim();
  SESSION_WEBHOOK_URL = clean;
  if (clean && typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.registerKnownSecret) {
    AU_CRED_BROKER.registerKnownSecret(clean);
  }
  if (AU_STORAGE.isSessionVaultAvailable && AU_STORAGE.isSessionVaultAvailable()) {
    await AU_STORAGE.setSessionSecret('webhookUrl', clean);
  }
  return clean;
}

// ARENA-18: Monotonic room-binding epoch & cryptographic tempchat bridge token helpers
function nextTabBindingEpoch(tabId) {
  const next = Number(TAB_BINDING_EPOCHS.get(tabId) || 0) + 1;
  TAB_BINDING_EPOCHS.set(tabId, next);
  return next;
}

function getOrCreateExtTabBindingToken(tabId) {
  if (EXT_TAB_BINDING_TOKENS.has(tabId)) return EXT_TAB_BINDING_TOKENS.get(tabId);
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const tok =
    'extbind_' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  EXT_TAB_BINDING_TOKENS.set(tabId, tok);
  return tok;
}

// ARENA-18: Content scripts may report status/loops/tokens, NEVER room membership or binding epoch!
function mergeTabStatePreservingRoomAuthority(tabId, existing = {}, incoming = {}) {
  const safeIncoming = Object.assign({}, incoming || {});
  const authRoomId = existing.collabRoomId || '';
  const authEpoch = Number(existing.bindingEpoch || existing.collabBindingEpoch || TAB_BINDING_EPOCHS.get(tabId) || 0);
  const authAgentName = existing.collabAgentName || '';

  // If content script reported a stale/unauthorized collabRoomId, schedule an immediate unbind command
  if (safeIncoming.collabRoomId && String(safeIncoming.collabRoomId) !== String(authRoomId)) {
    setTimeout(() => {
      sendTabMessageGroupSafe(
        tabId,
        { type: 'AU_EXECUTE_TAB_COMMAND', command: 'leave_collab_room', payload: {} },
        1200
      ).catch(() => {});
    }, 20);
  }

  delete safeIncoming.collabRoomId;
  delete safeIncoming.bindingEpoch;
  delete safeIncoming.collabBindingEpoch;
  if (!authRoomId) {
    delete safeIncoming.collabAgentName;
  }

  const finalEpoch = authRoomId ? Math.max(1, authEpoch) : 0;
  return Object.assign({}, existing, safeIncoming, {
    tabId,
    collabRoomId: authRoomId,
    bindingEpoch: finalEpoch,
    collabBindingEpoch: finalEpoch,
    collabAgentName: authRoomId ? (authAgentName || safeIncoming.collabAgentName || '') : '',
    lastActivityAt: Date.now()
  });
}

function generateVaultCap() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return (
    'aucap_' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

function ensureRoomVaultCaps(room) {
  if (!room || !room.roomId) return {};
  const rid = String(room.roomId);
  let caps = ROOM_VAULT_CAPS.get(rid);
  if (!caps || typeof caps !== 'object') {
    caps = {};
  }
  const slotCount = Math.max(
    (Array.isArray(room.roles) ? room.roles.length : 0),
    (Array.isArray(room.agents) ? room.agents.length : 0),
    1
  );
  let changed = false;
  for (let i = 1; i <= slotCount; i++) {
    const key = `ag${i}`;
    if (!caps[key]) {
      caps[key] = generateVaultCap();
      changed = true;
    }
  }
  if (changed || !ROOM_VAULT_CAPS.has(rid)) {
    ROOM_VAULT_CAPS.set(rid, caps);
    persistVolatileWorkerState();
  }
  return caps;
}

function getVaultSessionStatus(settings = {}, hasToken = false, nowMs = Date.now()) {
  const ttlMinutes = Math.max(0, Number(settings.githubVaultSessionTtlMinutes ?? 480));
  if (VAULT_CREDENTIAL_META.revokedAt) {
    return {
      active: false,
      revoked: true,
      expired: false,
      isExpired: false,
      sessionUnavailable: Boolean(VAULT_CREDENTIAL_META.sessionUnavailable),
      ttlMinutes,
      storedAt: 0,
      expiresAtMs: 0,
      remainingMs: 0,
      remainingMinutes: 0,
      label: 'Cofre revogado manualmente'
    };
  }
  if (!hasToken) {
    return {
      active: false,
      revoked: false,
      expired: false,
      isExpired: false,
      sessionUnavailable: Boolean(VAULT_CREDENTIAL_META.sessionUnavailable),
      ttlMinutes,
      storedAt: 0,
      expiresAtMs: 0,
      remainingMs: 0,
      remainingMinutes: 0,
      label: VAULT_CREDENTIAL_META.sessionUnavailable
        ? 'Cofre de sessão indisponível (bloqueado p/ evitar texto puro em disco)'
        : 'Nenhuma credencial ativa no Cofre'
    };
  }
  if (!VAULT_CREDENTIAL_META.storedAt) {
    VAULT_CREDENTIAL_META.storedAt = nowMs;
    persistVolatileWorkerState();
  }
  if (ttlMinutes <= 0) {
    return {
      active: true,
      revoked: false,
      expired: false,
      isExpired: false,
      sessionUnavailable: Boolean(VAULT_CREDENTIAL_META.sessionUnavailable),
      ttlMinutes: 0,
      storedAt: VAULT_CREDENTIAL_META.storedAt,
      expiresAtMs: 0,
      remainingMs: null,
      remainingMinutes: null,
      label: 'Sessão do Cofre ilimitada (enquanto não revogada)'
    };
  }
  const expiresAtMs = VAULT_CREDENTIAL_META.storedAt + ttlMinutes * 60000;
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) {
    return {
      active: false,
      revoked: false,
      expired: true,
      isExpired: true,
      sessionUnavailable: Boolean(VAULT_CREDENTIAL_META.sessionUnavailable),
      ttlMinutes,
      storedAt: VAULT_CREDENTIAL_META.storedAt,
      expiresAtMs,
      remainingMs: 0,
      remainingMinutes: 0,
      label: `Sessão do Cofre expirada (TTL ${ttlMinutes} min atingido)`
    };
  }
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const h = Math.floor(remainingMs / 3600000);
  const m = Math.floor((remainingMs % 3600000) / 60000);
  return {
    active: true,
    revoked: false,
    expired: false,
    isExpired: false,
    sessionUnavailable: Boolean(VAULT_CREDENTIAL_META.sessionUnavailable),
    ttlMinutes,
    storedAt: VAULT_CREDENTIAL_META.storedAt,
    expiresAtMs,
    remainingMs,
    remainingMinutes,
    label: h > 0 ? `Cofre ativo • expira em ${h}h ${m}m` : `Cofre ativo • expira em ${m} min`
  };
}

function getActiveVaultToken(roomId, settings = {}) {
  if (VAULT_CREDENTIAL_META.revokedAt) return '';
  const roomTok = roomId ? ROOM_GITHUB_TOKENS.get(String(roomId)) || '' : '';
  const rawTok = AU_INTEGRATIONS.normalizeGithubToken(roomTok || SESSION_GLOBAL_GITHUB_TOKEN || '');
  if (!rawTok) return '';
  if (typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.registerKnownSecret) {
    AU_CRED_BROKER.registerKnownSecret(rawTok);
  }
  const st = getVaultSessionStatus(settings, true);
  if (!st.active || st.isExpired || st.revoked) return '';
  return rawTok;
}

let heartbeatTimer = null;
let lastBroadcastTickAt = 0;
let offscreenSyncInFlight = false;

function isArenaUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.hostname === 'help.arena.ai') return false;
    if (u.pathname.startsWith('/blog')) return false;
    return (
      u.hostname === 'arena.ai' ||
      u.hostname.endsWith('.arena.ai') ||
      u.hostname === 'lmarena.ai' ||
      u.hostname.endsWith('.lmarena.ai')
    );
  } catch (_) {
    return false;
  }
}

function detectModeFromUrl(url) {
  if (!url) return 'chat';
  if (/\/agent(\/|$|\?)/i.test(url) || /[?&]mode=agent/i.test(url)) return 'agent';
  if (/\/battle(\/|$|\?)/i.test(url) || /[?&]mode=battle/i.test(url)) return 'battle';
  return 'chat';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let lastBadgeText = null;
let lastBadgeColor = null;

async function applyBadgeIfChanged(text, color) {
  if (color && color !== lastBadgeColor) {
    lastBadgeColor = color;
    await chrome.action.setBadgeBackgroundColor({ color });
  }
  if (text !== lastBadgeText) {
    lastBadgeText = text;
    await chrome.action.setBadgeText({ text });
  }
}

async function refreshExtensionBadge() {
  try {
    const settings = await AU_STORAGE.getSettings();
    if (!settings.badgeEnabled) {
      await applyBadgeIfChanged('', null);
      return;
    }

    let activeLoops = 0;
    let tokenStopped = 0;
    let captchaWaiting = 0;
    let waitingHuman = 0;
    for (const st of TAB_STATES.values()) {
      if (st.status === 'token_stopped') tokenStopped += 1;
      else if (st.status === 'captcha_waiting') captchaWaiting += 1;
      else if (st.status === 'waiting_user' || st.status === 'needs_human') waitingHuman += 1;
      else if (st.autoContinueEnabled) activeLoops += 1;
    }
    for (const r of COLLAB_ROOMS.values()) {
      if (r && r.status === 'needs_human') waitingHuman += 1;
    }

    if (tokenStopped > 0) {
      await applyBadgeIfChanged('!' + (tokenStopped > 1 ? tokenStopped : ''), '#ef4444');
    } else if (captchaWaiting > 0) {
      await applyBadgeIfChanged('?' + (captchaWaiting > 1 ? captchaWaiting : ''), '#f59e0b');
    } else if (waitingHuman > 0) {
      await applyBadgeIfChanged('⏸' + (waitingHuman > 1 ? waitingHuman : ''), '#d97706');
    } else if (activeLoops > 0) {
      await applyBadgeIfChanged(String(activeLoops), '#10b981');
    } else {
      await applyBadgeIfChanged('', null);
    }
  } catch (_) {}
}

const PERSISTED_TABS_KEY = 'au_persisted_tab_states';
let lastDiscardReviveAt = 0;
let discardReviveCursor = 0;
let cachedConvStates = {};
let persistDebounceTimer = null;
const PROTECTED_TABS = new Map(); // tabId -> boolean (deduplicates chrome.tabs.update autoDiscardable IPC)

function extractConvKey(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:c|agent)\/([^/?#]+)/i);
    return m ? `/${m[1]}` : '';
  } catch (_) {
    return '';
  }
}

// =========================================================================
// COLLAPSED ("MINIMIZED") TAB GROUP UNLOCKER
// Chromium's TabGroupsCollapseFreezing freezes all tabs inside a collapsed
// Tab Group (group.collapsed === true), causing sendMessage & timers to stall.
// Whenever we need to communicate with or wake a tab inside a collapsed group,
// we pulse the group open briefly (preserving active tab focus!) and re-collapse!
// =========================================================================
const ACTIVE_GROUP_PULSES = new Map(); // groupId -> refCount

async function withCollapsedGroupAwake(tabId, actionFn) {
  if (!tabId || !chrome.tabs || typeof chrome.tabs.get !== 'function') {
    return actionFn();
  }
  let groupId = -1;
  let wasCollapsed = false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (
      tab &&
      typeof tab.groupId === 'number' &&
      tab.groupId >= 0 &&
      chrome.tabGroups &&
      typeof chrome.tabGroups.get === 'function' &&
      typeof chrome.tabGroups.update === 'function'
    ) {
      const grp = await chrome.tabGroups.get(tab.groupId);
      if (grp && grp.collapsed) {
        groupId = tab.groupId;
        wasCollapsed = true;
      }
    }
  } catch (_) {}

  if (!wasCollapsed) {
    return actionFn();
  }

  const prevCount = ACTIVE_GROUP_PULSES.get(groupId) || 0;
  ACTIVE_GROUP_PULSES.set(groupId, prevCount + 1);
  if (prevCount === 0) {
    try {
      await chrome.tabGroups.update(groupId, { collapsed: false });
      await sleep(110);
    } catch (_) {}
  }

  try {
    const out = await actionFn();
    await sleep(140);
    return out;
  } finally {
    const rem = (ACTIVE_GROUP_PULSES.get(groupId) || 1) - 1;
    if (rem <= 0) {
      ACTIVE_GROUP_PULSES.delete(groupId);
      try {
        await chrome.tabGroups.update(groupId, { collapsed: true });
      } catch (_) {}
    } else {
      ACTIVE_GROUP_PULSES.set(groupId, rem);
    }
  }
}

async function sendTabMessageGroupSafe(tabId, message, timeoutMs = 1800) {
  const tryOnce = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = (val, ok) => {
        if (done) return;
        done = true;
        resolve({ ok, val });
      };
      const tm = setTimeout(() => finish(null, false), timeoutMs);
      try {
        const maybePromise = chrome.tabs.sendMessage(tabId, message, (res) => {
          clearTimeout(tm);
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) finish(null, false);
          else finish(res, true);
        });
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(() => {});
        }
      } catch (_) {
        clearTimeout(tm);
        finish(null, false);
      }
    });

  const first = await tryOnce();
  if (first.ok) return first.val;

  // Retry waking collapsed Tab Group if the tab was frozen inside a minimized group!
  return withCollapsedGroupAwake(tabId, async () => {
    const second = await tryOnce();
    return second.val;
  });
}

function serializeAutopilotSnapshot(st) {
  return {
    autoContinueEnabled: Boolean(st.autoContinueEnabled),
    strategy: st.strategy || 'hybrid',
    customFixedPrompt: st.customFixedPrompt || '',
    promptQueue: Array.isArray(st.promptQueue) ? st.promptQueue.slice() : [],
    status: st.status || 'idle',
    loopsCount: Number(st.loopsCount || 0),
    queueLength: Number(st.queueLength || 0),
    estimatedTokens: Number(st.estimatedTokens || 0),
    stopReason: st.stopReason || '',
    collabRoomId: st.collabRoomId || '',
    collabAgentName: st.collabAgentName || '',
    githubActive: Boolean(st.githubActive),
    githubRepo: st.githubRepo || '',
    githubBaseBranch: st.githubBaseBranch || '',
    githubBranch: st.githubBranch || '',
    updatedAt: Date.now()
  };
}

function flushPersistTabStatesNow() {
  persistDebounceTimer = null;
  try {
    const byTab = {};
    const byConv = Object.assign({}, cachedConvStates);

    for (const [id, st] of TAB_STATES.entries()) {
      const snap = serializeAutopilotSnapshot(st);
      byTab[id] = snap;
      const convKey = extractConvKey(st.url);
      if (convKey) {
        byConv[convKey] = snap;
      }
    }

    // Prune conversation cache to 60 most recent entries to keep storage tiny
    const convKeys = Object.keys(byConv);
    if (convKeys.length > 60) {
      convKeys
        .sort((a, b) => (byConv[b].updatedAt || 0) - (byConv[a].updatedAt || 0))
        .slice(60)
        .forEach((k) => delete byConv[k]);
    }
    cachedConvStates = byConv;

    chrome.storage.local.set({ [PERSISTED_TABS_KEY]: { byTab, byConv } }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

function persistTabStates(immediate = false) {
  if (immediate) {
    if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
    flushPersistTabStatesNow();
    return;
  }
  if (persistDebounceTimer) return;
  persistDebounceTimer = setTimeout(flushPersistTabStatesNow, 350);
}

function loadPersistedTabStates() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([PERSISTED_TABS_KEY], (res) => {
        void chrome.runtime.lastError;
        const raw = (res && res[PERSISTED_TABS_KEY]) || {};
        if (raw.byTab || raw.byConv) {
          cachedConvStates = raw.byConv || cachedConvStates;
          resolve({ byTab: raw.byTab || {}, byConv: raw.byConv || {} });
        } else {
          // Backward compatibility with v1.9.0 flat map
          resolve({ byTab: raw, byConv: {} });
        }
      });
    } catch (_) {
      resolve({ byTab: {}, byConv: {} });
    }
  });
}

// =========================================================================
// MODO COLABORAÇÃO (TEMPCHAT MULTI-AGENT ROOM ENGINE)
// =========================================================================
const PERSISTED_COLLAB_KEY = 'au_collab_rooms_v1';
let collabRoomsLoaded = false;
let persistCollabTimer = null;

function flushPersistCollabRoomsNow() {
  persistCollabTimer = null;
  try {
    const roomsArr = Array.from(COLLAB_ROOMS.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 15);
    chrome.storage.local.set({ [PERSISTED_COLLAB_KEY]: roomsArr }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

function persistCollabRooms(immediate = false) {
  if (immediate) {
    if (persistCollabTimer) clearTimeout(persistCollabTimer);
    flushPersistCollabRoomsNow();
    return;
  }
  if (persistCollabTimer) return;
  persistCollabTimer = setTimeout(flushPersistCollabRoomsNow, 1500);
}

function isBlockedChatMessageEntry(m) {
  if (!m || typeof m !== 'object') return true;
  const txt = String(m.text || '').trim();
  if (!txt) return true;
  if (AU_DEFAULTS && typeof AU_DEFAULTS.isSystemOrAutoPromptText === 'function' && AU_DEFAULTS.isSystemOrAutoPromptText(txt)) {
    return true;
  }
  const isGithubEvent =
    m.senderType === 'github' ||
    m.senderType === 'github_radar' ||
    m.senderName === 'GitHub Push' ||
    m.senderName === 'GitHub' ||
    m.senderName === 'Radar Git' ||
    m.senderName === 'Integração Final';
  if (m.senderType === 'system' && !isGithubEvent) {
    return true;
  }
  return false;
}

function ensureRoomBoardInitialized(room) {
  if (!room) return null;
  if (!room.sharedBoard || typeof room.sharedBoard !== 'object') {
    room.sharedBoard = AU_COLLAB.createInitialSharedBoard(
      room.roles || room.agents || [],
      room.roomId || '0000',
      room.githubConfig || null
    );
  }
  if (!room.sharedBoard.assignments || typeof room.sharedBoard.assignments !== 'object') {
    room.sharedBoard.assignments = {};
  }
  if (!room.sharedBoard.contracts || typeof room.sharedBoard.contracts !== 'object') {
    room.sharedBoard.contracts = {};
  }
  if (!room.sharedBoard.gitRefs || typeof room.sharedBoard.gitRefs !== 'object') {
    room.sharedBoard.gitRefs = { branches: {}, pulls: {} };
  }
  return room.sharedBoard;
}

async function publishBoardStateToBin(room) {
  if (!room || !room.filebinId) return false;
  try {
    ensureRoomBoardInitialized(room);
    const integration = AU_COLLAB.computeRoomIntegrationStatus(room);
    const payload = {
      roomId: room.roomId,
      rev: room.sharedBoard.rev || 1,
      updatedAt: Date.now(),
      integration,
      assignments: room.sharedBoard.assignments || {},
      contracts: room.sharedBoard.contracts || {},
      gitRefs: room.sharedBoard.gitRefs || { branches: {}, pulls: {} }
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
    await AU_INTEGRATIONS.uploadWithFallback(bytes, 'au_board_state.json', {
      primaryProvider: 'filebin',
      autoFallback: false,
      binId: room.filebinId,
      mimeType: 'application/json'
    });
    return true;
  } catch (_) {
    return false;
  }
}

function notifyLiveChatRoomDelta(room, message = null) {
  if (!room) return;
  try {
    const p = chrome.runtime.sendMessage({
      type: 'AU_LIVECHAT_ROOM_DELTA',
      roomId: room.roomId,
      seq: room.seq,
      roomStatus: room.status,
      boardRev: room.sharedBoard ? room.sharedBoard.rev : 1,
      message
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}

// SPEC.md §7.5 (M1–M5): Migrate legacy v3.x persisted rooms into strict v4.0 room-isolated format
function migrateLegacyRoomObject(r, seenActiveTabs) {
  if (!r || !r.roomId) return false;
  let mutated = false;
  const rid = String(r.roomId);

  // M1: Re-key weak/shared filebinId so each room has a room-scoped CSPRNG bucket
  if (!r.filebinId || !String(r.filebinId).includes(rid) || String(r.filebinId).length < 18) {
    r.filebinId = AU_INTEGRATIONS.generateFilebinId(rid);
    mutated = true;
  }

  // M2: Initialize roomHmacKey, leaderEpoch, bindingEpoch, and lastSeenSeq
  if (!r.roomHmacKey && typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.generateRoomHmacKeyHex) {
    r.roomHmacKey = AU_CRED_BROKER.generateRoomHmacKeyHex();
    mutated = true;
  }
  if (!r.leaderEpoch || Number(r.leaderEpoch) < 1) {
    r.leaderEpoch = 1;
    mutated = true;
  }

  // M5a: Normalize legacy GitHub auth mode and strip any accidentally persisted token inside githubConfig
  if (r.githubConfig && typeof r.githubConfig === 'object') {
    const normMode = AU_DEFAULTS.normalizeGithubAuthMode(r.githubConfig.authMode);
    if (r.githubConfig.authMode !== normMode) {
      r.githubConfig.authMode = normMode;
      mutated = true;
    }
    if ('token' in r.githubConfig) {
      delete r.githubConfig.token;
      mutated = true;
    }
  }

  // M3 & M5b: Evict cross-room messages & scrub residual secrets / reasoning blocks
  if (Array.isArray(r.messages)) {
    const beforeLen = r.messages.length;
    const cleaned = [];
    for (const m of r.messages) {
      if (!m || isBlockedChatMessageEntry(m)) {
        mutated = true;
        continue;
      }
      if (m.roomId && String(m.roomId) !== rid) {
        r.quarantinedCrossRoomCount = Number(r.quarantinedCrossRoomCount || 0) + 1;
        mutated = true;
        continue;
      }
      if (!m.roomId) {
        m.roomId = rid;
        mutated = true;
      }
      if (typeof m.text === 'string') {
        const scrubbed = AU_INTEGRATIONS.scrubSecrets(m.text);
        if (scrubbed !== m.text) {
          m.text = scrubbed;
          mutated = true;
        }
      }
      cleaned.push(m);
    }
    if (cleaned.length !== beforeLen) mutated = true;
    r.messages = cleaned;
  }

  if (typeof r.finalDeliverable === 'string' && r.finalDeliverable) {
    const sc = AU_INTEGRATIONS.scrubSecrets(r.finalDeliverable);
    if (sc !== r.finalDeliverable) {
      r.finalDeliverable = sc;
      mutated = true;
    }
  }

  // M4: Ensure each agent has monotonic bindingEpoch and no single tabId belongs to two active rooms simultaneously
  if (Array.isArray(r.agents)) {
    for (const a of r.agents) {
      if (!a) continue;
      if (!a.bindingEpoch || Number(a.bindingEpoch) < 1) {
        a.bindingEpoch = 1;
        mutated = true;
      }
      if (a.lastSeenSeq === undefined) {
        a.lastSeenSeq = Number(r.seq || 0);
        mutated = true;
      }
      if (r.status === 'active' && !a.closed && a.tabId && seenActiveTabs) {
        if (seenActiveTabs.has(a.tabId)) {
          a.closed = true;
          a.bindingEpoch = Number(a.bindingEpoch || 1) + 1;
          mutated = true;
        } else {
          seenActiveTabs.add(a.tabId);
          TAB_BINDING_EPOCHS.set(a.tabId, Math.max(Number(TAB_BINDING_EPOCHS.get(a.tabId) || 0), Number(a.bindingEpoch)));
        }
      }
    }
  }

  return mutated;
}

async function ensureCollabRoomsLoaded() {
  if (collabRoomsLoaded) return;
  collabRoomsLoaded = true;
  let scrubbedAny = false;
  await new Promise((resolve) => {
    try {
      chrome.storage.local.get([PERSISTED_COLLAB_KEY], (res) => {
        void chrome.runtime.lastError;
        const arr = Array.isArray(res && res[PERSISTED_COLLAB_KEY]) ? res[PERSISTED_COLLAB_KEY] : [];
        // Sort newest-first when checking M4 tab deduplication so newest room keeps active tab ownership
        const sorted = arr.slice().sort((a, b) => Number((b && b.updatedAt) || 0) - Number((a && a.updatedAt) || 0));
        const seenActiveTabs = new Set();
        for (const r of sorted) {
          if (r && r.roomId && !COLLAB_ROOMS.has(r.roomId)) {
            if (migrateLegacyRoomObject(r, seenActiveTabs)) {
              scrubbedAny = true;
            }
            ensureRoomBoardInitialized(r);
            COLLAB_ROOMS.set(r.roomId, r);
            if (r.externalTabId) {
              EXT_TAB_TO_ROOM.set(r.externalTabId, r.roomId);
              getOrCreateExtTabBindingToken(r.externalTabId);
            }
          }
        }
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
  if (scrubbedAny) {
    persistCollabRooms(true);
  }
}

function serializeRoomForClient(room) {
  if (!room) return null;
  ensureRoomBoardInitialized(room);
  const integrationStatus = AU_COLLAB.computeRoomIntegrationStatus(room);
  const consensusMatrix =
    typeof AU_COLLAB.computeRoomConsensusMatrix === 'function'
      ? AU_COLLAB.computeRoomConsensusMatrix(room)
      : null;
  const agents = (Array.isArray(room.agents) ? room.agents : []).map((a, idx) => {
    const liveTab = TAB_STATES.get(a.tabId);
    const admitted = a.admittedToTeam !== false;
    const roleForBr = {
      index: a.index !== undefined ? a.index : idx,
      agentIndex: (a.index !== undefined ? a.index : idx) + 1,
      shortTitle: a.name,
      roleTitle: a.roleTitle,
      isSynthesizer: Boolean(a.isSynthesizer),
      githubAccessLevel: a.githubAccessLevel || 'auto_role'
    };
    const assignedBranch =
      room.githubConfig && room.githubConfig.enabled
        ? AU_COLLAB.computeAgentBranchName(room.roomId, roleForBr, room.githubConfig)
        : '';
    const effectiveGithubAccess = AU_COLLAB.resolveEffectiveAgentAccessLevel(roleForBr, room.githubConfig || {});
    const slotKey = `ag${(a.index !== undefined ? a.index : idx) + 1}`;
    const boardSlot = (room.sharedBoard.assignments && room.sharedBoard.assignments[slotKey]) || null;
    return {
      tabId: a.tabId,
      index: a.index,
      slotKey,
      bindingEpoch: Number(a.bindingEpoch || 1),
      name: a.name,
      agentKit: a.agentKit || null,
      roleTitle: a.roleTitle,
      roleDesc: a.roleDesc,
      isSynthesizer: Boolean(a.isSynthesizer),
      consensusVote: a.consensusVote || null,
      githubAccessLevel: a.githubAccessLevel || 'auto_role',
      effectiveGithubAccess,
      assignedBranch,
      boardStatus: boardSlot ? boardSlot.status : 'pendente',
      admittedToTeam: admitted,
      screeningStatus: a.screeningStatus || (admitted ? 'admitted' : 'screening'),
      refusedCount: Number(a.refusedCount || 0),
      turnsCount: Number(a.turnsCount || 0),
      lastSeenSeq: Number(a.lastSeenSeq || 0),
      closed: Boolean(a.closed),
      liveStatus: liveTab ? liveTab.status : (a.closed ? 'closed' : 'idle'),
      loopsCount: liveTab ? Number(liveTab.loopsCount || 0) : Number(a.turnsCount || 0),
      tabTitle: liveTab ? liveTab.title : a.name,
      autoContinueEnabled: liveTab ? Boolean(liveTab.autoContinueEnabled) : false
    };
  });
  const admittedCount = agents.filter((a) => a.admittedToTeam && !a.closed).length;
  const screeningCount = agents.filter((a) => !a.admittedToTeam && !a.closed && a.screeningStatus !== 'refused_stopped').length;
  const totalRefusedThinking = agents.reduce((acc, a) => acc + Number(a.refusedCount || 0), 0);
  const thinkingRefusalsCount = Math.max(Number(room.thinkingRefusalsCount || 0), totalRefusedThinking);
  const cleanMessages = (Array.isArray(room.messages) ? room.messages : [])
    .filter((m) => !isBlockedChatMessageEntry(m))
    .slice(-120);

  return {
    roomId: room.roomId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    status: room.status || 'active',
    leaderEpoch: Number(room.leaderEpoch || 1),
    profile: room.profile || 'specialists',
    stopMode: room.stopMode || 'smart_consensus',
    refuseThinkingModels: room.refuseThinkingModels !== false,
    admittedCount,
    screeningCount,
    totalRefusedThinking: thinkingRefusalsCount,
    thinkingRefusalsCount,
    deduplicatedMessagesCount: Number(room.deduplicatedMessagesCount || 0),
    dedupDroppedCount: Number(room.deduplicatedMessagesCount || 0),
    quarantinedCrossRoomCount: Number(room.quarantinedCrossRoomCount || 0),
    integrationStatus,
    consensusMatrix,
    taskPolicy: room.taskPolicy || null,
    agentKitEnabled: room.agentKitEnabled === true,
    sharedBoard: room.sharedBoard,
    harness: room.harness ? { gate: AU_HARNESS.gate(room), events: room.harness.events.slice(-10) } : null,
    baseTask: room.baseTask || '',
    mirrorExternal: Boolean(room.mirrorExternal),
    externalTabId: room.externalTabId || null,
    externalCode: room.externalCode || '',
    filebinId: room.filebinId || '',
    filebinUrl: room.filebinId ? `https://filebin.net/${room.filebinId}` : '',
    sharedFiles: (Array.isArray(room.sharedFiles) ? room.sharedFiles : []).slice(-60),
    githubConfig: room.githubConfig
      ? {
          enabled: Boolean(room.githubConfig.enabled),
          repo: room.githubConfig.repo || '',
          baseBranch: room.githubConfig.baseBranch || 'main',
          authMode: AU_DEFAULTS.normalizeGithubAuthMode(room.githubConfig.authMode),
          branchMode: room.githubConfig.branchMode || 'branch_per_agent_pr',
          sharedBranch: room.githubConfig.sharedBranch || '',
          defaultAgentAccessMode: room.githubConfig.defaultAgentAccessMode || 'auto_role',
          commitsPushed: Number(room.githubConfig.commitsPushed || 0),
          lastCommitUrl: room.githubConfig.lastCommitUrl || '',
          pullRequestUrl: room.githubConfig.pullRequestUrl || ''
        }
      : null,
    seq: Number(room.seq || 0),
    agents,
    messages: cleanMessages,
    finalDeliverable: room.finalDeliverable || '',
    finalBy: room.finalBy || ''
  };
}

const AGENT_MESSAGE_QUEUES = new Map();

async function appendRoomMessage(room, msgInput, forwardToExternal = true, explicitToken = '') {
  // Humans never wait behind the agent queue. Queue keys are room-local.
  if (!room || !msgInput || msgInput.senderType !== 'agent') {
    return appendRoomMessageNow(room, msgInput, forwardToExternal, explicitToken);
  }
  const key = String(room.roomId);
  const prior = AGENT_MESSAGE_QUEUES.get(key) || Promise.resolve();
  const pending = prior.catch(() => {}).then(async () => {
    await sleep(300 + Math.floor(Math.random() * 451));
    return appendRoomMessageNow(room, msgInput, forwardToExternal, explicitToken);
  });
  AGENT_MESSAGE_QUEUES.set(key, pending);
  try { return await pending; }
  finally { if (AGENT_MESSAGE_QUEUES.get(key) === pending) AGENT_MESSAGE_QUEUES.delete(key); }
}

function appendRoomMessageNow(room, msgInput, forwardToExternal = true, explicitToken = '') {
  if (!room || !msgInput) return null;
  room.updatedAt = Date.now();
  const roomTok = room.roomId ? ROOM_GITHUB_TOKENS.get(String(room.roomId)) || '' : '';
  let rawClean = String(msgInput.text || '').trim();
  // ARENA-02: Strip any <details>/<thought> hidden reasoning blocks before publishing to room feed
  if (AU_INTEGRATIONS && typeof AU_INTEGRATIONS.scrubReasoningBlocks === 'function') {
    rawClean = AU_INTEGRATIONS.scrubReasoningBlocks(rawClean).text;
  }
  let safeText = AU_INTEGRATIONS.scrubSecrets(rawClean, explicitToken || roomTok || SESSION_GLOBAL_GITHUB_TOKEN);
  if (explicitToken && roomTok && explicitToken !== roomTok) {
    safeText = AU_INTEGRATIONS.scrubSecrets(safeText, roomTok);
  }
  if (!safeText) return null;

  if (
    AU_DEFAULTS &&
    typeof AU_DEFAULTS.isSystemOrAutoPromptText === 'function' &&
    AU_DEFAULTS.isSystemOrAutoPromptText(safeText)
  ) {
    return null;
  }

  const isGithubEvent =
    msgInput.senderType === 'github' ||
    msgInput.senderType === 'github_radar' ||
    msgInput.senderName === 'GitHub Push' ||
    msgInput.senderName === 'GitHub' ||
    msgInput.senderName === 'Radar Git' ||
    msgInput.senderName === 'Integração Final' ||
    msgInput.senderName === 'Eleição de Líder';
  const effectiveType = isGithubEvent ? 'github' : msgInput.senderType || 'agent';

  if (effectiveType === 'system') {
    persistCollabRooms();
    return null;
  }

  const nowTs = Date.now();
  const senderLabel = msgInput.senderName || 'Agente';
  const fingerprint = AU_COLLAB.computeMessageFingerprint(senderLabel, safeText);
  if (!Array.isArray(room.messages)) room.messages = [];
  if (fingerprint && !msgInput.bypassDedup) {
    const isDupe = room.messages.slice(-45).some((prev) => {
      if (!prev) return false;
      const prevFp = prev.fingerprint || AU_COLLAB.computeMessageFingerprint(prev.senderName, prev.text);
      return prevFp === fingerprint && nowTs - Number(prev.timestamp || 0) < 600000;
    });
    if (isDupe) {
      room.deduplicatedMessagesCount = Number(room.deduplicatedMessagesCount || 0) + 1;
      persistCollabRooms();
      return null;
    }
  }

  room.seq = Number(room.seq || 0) + 1;
  const msgObj = {
    seq: room.seq,
    roomId: room.roomId,
    id: 'tc_' + room.roomId + '_' + room.seq,
    senderType: effectiveType, // 'agent' | 'user' | 'external' | 'github'
    senderName: senderLabel,
    senderRole: msgInput.senderRole || '',
    externalUnverified: Boolean(msgInput.externalUnverified || effectiveType === 'external'),
    tabId: msgInput.tabId || null,
    text: safeText,
    fingerprint,
    timestamp: nowTs
  };
  room.messages.push(msgObj);
  if (room.messages.length > 200) {
    room.messages = room.messages.slice(-200);
  }
  persistCollabRooms();

  if (msgObj.senderType !== 'system') {
    AU_STORAGE.updateMetrics((m) => {
      m.totalCollabMessagesExchanged = (m.totalCollabMessagesExchanged || 0) + 1;
      return m;
    }).catch(() => {});
  }

  notifyLiveChatRoomDelta(room, msgObj);
  // Only admitted peers of this exact room receive notifications; never inject a new turn.
  for (const peer of room.agents || []) {
    if (!peer || peer.closed || !peer.tabId || peer.tabId === msgObj.tabId) continue;
    const direct = AU_COLLAB.isAgentMentioned(msgObj.text, Number(peer.index || 0) + 1, peer.name || peer.shortTitle, peer.roleTitle);
    chrome.tabs.sendMessage(peer.tabId, {
      type: 'AU_ROOM_MESSAGE_NOTIFICATION', roomId: room.roomId,
      bindingEpoch: peer.bindingEpoch || 1, seq: msgObj.seq, direct,
      senderName: msgObj.senderName
    }).catch(() => {});
  }
  wakeWaitingPeersInRoom(room, msgObj.tabId);

  if (forwardToExternal && room.externalTabId && msgObj.senderType !== 'system' && msgObj.senderType !== 'external') {
    const prefix =
      msgObj.senderType === 'user'
        ? '👤 [Coordenador Humano]'
        : msgObj.senderType === 'github'
          ? `🔔 [${msgObj.senderName}]`
          : `🤖 [${msgObj.senderName}]`;
    const outboundText = `${prefix}: ${msgObj.text.slice(0, 1400)}`;
    sendTabMessageGroupSafe(
      room.externalTabId,
      {
        type: 'AU_TEMPCHAT_OUTBOUND_SEND',
        roomId: room.roomId,
        text: outboundText
      },
      1600
    ).catch(() => {});
  }

  return msgObj;
}

// Immediately pulse/wake peer tabs parked in wait_peers when teammates finish a round or post live updates!
function wakeWaitingPeersInRoom(room, excludeTabId = null) {
  if (!room || !Array.isArray(room.agents)) return;
  for (const peer of room.agents) {
    if (!peer || peer.closed || !peer.tabId || peer.tabId === excludeTabId) continue;
    const pst = TAB_STATES.get(peer.tabId);
    const isWaiting = Boolean(peer.waitingSince > 0 || (pst && pst.collabWaitingPeers));
    if (!isWaiting) continue;
    sendTabMessageGroupSafe(
      peer.tabId,
      {
        type: 'AU_HEARTBEAT_TICK',
        wakeCollabPeers: true,
        roomId: room.roomId
      },
      1200
    ).catch(() => {});
  }
}

async function openExternalTempChatBridgeTab(room, joinCode = '') {
  if (!room) return null;
  if (room.externalTabId) {
    try {
      const existing = await chrome.tabs.get(room.externalTabId);
      if (existing) return existing.id;
    } catch (_) {
      EXT_TAB_TO_ROOM.delete(room.externalTabId);
      EXT_TAB_BINDING_TOKENS.delete(room.externalTabId);
      room.externalTabId = null;
    }
  }
  const cleanJoin = String(joinCode || '').replace(/\D/g, '').slice(0, 4);
  try {
    // ARENA-18: Do not rely on URL hash for room binding; SW binds via EXT_TAB_TO_ROOM + bindingToken!
    const extUrl = cleanJoin.length === 4 ? `https://tempchat.online/#au_join=${cleanJoin}` : 'https://tempchat.online/';
    const extTab = await chrome.tabs.create({
      url: extUrl,
      active: false
    });
    room.externalTabId = extTab.id;
    room.mirrorExternal = true;
    if (cleanJoin.length === 4) room.pendingExternalJoinCode = cleanJoin;
    EXT_TAB_TO_ROOM.set(extTab.id, room.roomId);
    getOrCreateExtTabBindingToken(extTab.id);
    persistCollabRooms();
    return extTab.id;
  } catch (_) {
    return null;
  }
}

function registerSharedFileInRoom(room, fileMeta) {
  if (!room || !fileMeta || !fileMeta.url) return false;
  if (!Array.isArray(room.sharedFiles)) room.sharedFiles = [];
  if (room.sharedFiles.some((f) => f.url === fileMeta.url)) return false;

  const entry = {
    id: 'sf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    filename: fileMeta.filename || 'arquivo',
    provider: fileMeta.providerLabel || fileMeta.provider || AU_INTEGRATIONS.detectProviderFromUrl(fileMeta.url),
    sizeBytes: Number(fileMeta.sizeBytes || 0),
    url: fileMeta.url,
    uploadedBy: fileMeta.uploadedBy || 'Agente',
    timestamp: Date.now()
  };
  room.sharedFiles.push(entry);
  if (room.sharedFiles.length > 80) {
    room.sharedFiles = room.sharedFiles.slice(-80);
  }
  persistCollabRooms();

  AU_STORAGE.updateMetrics((m) => {
    m.totalTempFilesShared = (m.totalTempFilesShared || 0) + 1;
    return m;
  }).catch(() => {});

  return entry;
}

async function pushRealtimeMessageToBin(room, opts = {}) {
  if (!room || !room.filebinId) return false;
  const cleanText = String(opts.text || '').trim();
  if (!cleanText) return false;
  if (
    AU_DEFAULTS &&
    typeof AU_DEFAULTS.isSystemOrAutoPromptText === 'function' &&
    AU_DEFAULTS.isSystemOrAutoPromptText(cleanText)
  ) {
    return false;
  }
  try {
    const roomTok = ROOM_GITHUB_TOKENS.get(room.roomId) || '';
    const scrubbedReasoning =
      AU_INTEGRATIONS && typeof AU_INTEGRATIONS.scrubReasoningBlocks === 'function'
        ? AU_INTEGRATIONS.scrubReasoningBlocks(cleanText).text
        : cleanText;
    const safeText = AU_INTEGRATIONS.scrubSecrets(scrubbedReasoning, roomTok || SESSION_GLOBAL_GITHUB_TOKEN);
    const senderLabel = opts.senderName || 'Coordenador (Você)';
    const fp = AU_COLLAB.computeMessageFingerprint(senderLabel, safeText);
    if (!room.recentBinFps || typeof room.recentBinFps !== 'object') room.recentBinFps = {};
    const now = Date.now();
    if (fp && now - Number(room.recentBinFps[fp] || 0) < 45000) {
      return false;
    }
    if (fp) room.recentBinFps[fp] = now;

    const ts = now;
    const tag = String(opts.tag || 'coord').replace(/[^a-zA-Z0-9_-]/g, '');
    const randSuffix = Math.floor(100 + Math.random() * 900);
    const msgId = `m_${ts}_${tag}_${randSuffix}`;
    const fname = `auchat_${ts}_${tag}_${randSuffix}.json`;
    if (!Array.isArray(room.ingestedChatFiles)) room.ingestedChatFiles = [];
    room.ingestedChatFiles.push(fname);
    if (room.ingestedChatFiles.length > 250) {
      room.ingestedChatFiles = room.ingestedChatFiles.slice(-250);
    }
    persistCollabRooms();

    // SEC-08: Sign outbound room message with per-room HMAC-SHA256 (matching /tmp/au_chat Python canonical format)
    let sig = '';
    if (room.roomHmacKey && typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.signRoomMessage) {
      sig = await AU_CRED_BROKER.signRoomMessage(room.roomHmacKey, room.roomId, tag, ts, safeText, msgId);
    }

    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({
        id: msgId,
        roomId: room.roomId,
        sender: senderLabel,
        role: opts.senderRole || '',
        tag,
        text: safeText,
        fp,
        ts,
        ...(sig ? { hmacSig: sig, sig } : {}),
        ...(opts.externalUnverified ? { externalUnverified: true } : {})
      })
    );
    await AU_INTEGRATIONS.uploadWithFallback(payloadBytes, fname, {
      primaryProvider: 'filebin',
      autoFallback: true,
      binId: room.filebinId,
      mimeType: 'application/json'
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function checkAndAnnounceIntegrationReadiness(room) {
  if (!room || room.status !== 'active') return null;
  ensureRoomBoardInitialized(room);
  const integ = AU_COLLAB.computeRoomIntegrationStatus(room);
  if (
    (integ.state === 'ready_for_synthesis' || integ.state === 'timed_out_ready') &&
    room.lastAnnouncedIntegrationState !== integ.state
  ) {
    room.lastAnnouncedIntegrationState = integ.state;
    const alertText =
      integ.state === 'timed_out_ready'
        ? `⏰ Prazo limite de integração (${integ.timeoutMinutes} min) atingido! Estado alterado para PRONTO P/ SÍNTESE FINAL (${integ.readyCount}/${integ.expectedCount} módulos prontos). Líder Sintetizador liberado para consolidar agora.`
        : `🟢 Todos os módulos sinalizaram prontidão (${integ.readyCount}/${integ.expectedCount})! Integração Final liberada para consolidação imediata do Líder Sintetizador.`;
    await appendRoomMessage(
      room,
      {
        senderType: 'github',
        senderName: 'Integração Final',
        text: alertText
      },
      true
    );
    pushRealtimeMessageToBin(room, {
      senderName: 'Integração Final',
      senderRole: 'SLA & Estado',
      tag: 'gitradar',
      text: alertText
    }).catch(() => {});
    for (const peer of room.agents || []) {
      peer.waitingSince = 0;
    }
    publishBoardStateToBin(room).catch(() => {});
    persistCollabRooms();
  }
  return integ;
}

async function pollRoomGithubRadar(room, settingsOpt = null, minIntervalMs = 18000) {
  if (!room || !room.githubConfig || !room.githubConfig.enabled || !room.githubConfig.repo) return 0;
  const settings = settingsOpt || (await AU_STORAGE.getSettings());
  if (settings.githubAutoNotifyBranchesPrs === false) return 0;

  const now = Date.now();
  if (now - Number(room.lastGitRadarPollAt || 0) < minIntervalMs) return 0;
  room.lastGitRadarPollAt = now;

  const effectiveToken = getActiveVaultToken(room.roomId, settings);
  let snap;
  try {
    snap = await AU_INTEGRATIONS.github.pollRepoRefsSnapshot(
      effectiveToken,
      room.githubConfig.repo,
      settings.githubUsername || ''
    );
  } catch (_) {
    return 0;
  }
  if (!snap) return 0;

  ensureRoomBoardInitialized(room);
  const prevBranches = room.sharedBoard.gitRefs.branches || {};
  const prevPulls = room.sharedBoard.gitRefs.pulls || {};
  const isBaseline = !room.gitRadarBaselineDone;
  const roomBranchPrefix = `au/${room.roomId}`;
  const sharedBrName = room.githubConfig.sharedBranch || `au/tempchat-${room.roomId}`;
  const events = [];
  let refsChanged = false;

  const nextBranches = {};
  for (const b of snap.branches || []) {
    if (!b || !b.name) continue;
    const oldB = prevBranches[b.name];
    nextBranches[b.name] = { name: b.name, sha: b.sha || '', updatedAt: now };
    const isRoomBranch = b.name.startsWith(roomBranchPrefix) || b.name === sharedBrName || b.name.startsWith('au/pr-');
    if (!oldB) {
      refsChanged = true;
      if (!isBaseline || isRoomBranch) {
        events.push(`🌿 Nova branch surgiu: \`${b.name}\`${b.shortSha ? ` (@${b.shortSha})` : ''}`);
      }
    } else if (oldB.sha && b.sha && oldB.sha !== b.sha) {
      refsChanged = true;
      if (!isBaseline) {
        events.push(`🔄 Novos commits na branch \`${b.name}\` -> \`${b.shortSha || b.sha.slice(0, 7)}\``);
      }
    }
  }

  const nextPulls = {};
  for (const p of snap.pulls || []) {
    if (!p || !p.number) continue;
    const key = String(p.number);
    const oldP = prevPulls[key];
    nextPulls[key] = p;
    const isRoomPr =
      (p.head && (p.head.startsWith(roomBranchPrefix) || p.head === sharedBrName || p.head.startsWith('au/'))) || false;
    if (!oldP) {
      refsChanged = true;
      if (p.state === 'open' && (!isBaseline || isRoomPr)) {
        if (p.htmlUrl) room.githubConfig.pullRequestUrl = p.htmlUrl;
        events.push(
          `🔀 Novo Pull Request #${p.number} aberto${p.author ? ` por @${p.author}` : ''}: "${p.title}" (\`${p.head}\` -> \`${p.base}\`) ${p.htmlUrl || ''}`
        );
      }
    } else {
      if (!oldP.merged && p.merged) {
        refsChanged = true;
        events.push(`🟣 Pull Request #${p.number} MERGED em \`${p.base}\`: "${p.title}" ${p.htmlUrl || ''}`);
      } else if (oldP.state === 'open' && p.state === 'closed') {
        refsChanged = true;
        events.push(`⚪ Pull Request #${p.number} fechado: "${p.title}"`);
      } else if (oldP.headSha && p.headSha && oldP.headSha !== p.headSha && p.state === 'open' && !isBaseline) {
        refsChanged = true;
        events.push(`🔄 Pull Request #${p.number} recebeu novos commits (\`${p.headSha.slice(0, 7)}\`): ${p.htmlUrl || ''}`);
      }
    }
  }

  room.sharedBoard.gitRefs = { branches: nextBranches, pulls: nextPulls };
  room.sharedBoard.branches = nextBranches;
  room.sharedBoard.pullRequests = nextPulls;
  room.gitRadarBaselineDone = true;

  if (events.length > 0) {
    room.sharedBoard.rev = Number(room.sharedBoard.rev || 1) + 1;
    room.sharedBoard.revision = room.sharedBoard.rev;
    room.sharedBoard.updatedAt = now;
    const radarMsg = events.join('\n');
    await appendRoomMessage(
      room,
      {
        senderType: 'github',
        senderName: 'Radar Git',
        text: radarMsg
      },
      true,
      effectiveToken
    );
    pushRealtimeMessageToBin(room, {
      senderName: 'Radar Git',
      senderRole: 'Aviso Automático de Branches & PRs',
      tag: 'gitradar',
      text: radarMsg
    }).catch(() => {});
    for (const peer of room.agents || []) {
      peer.waitingSince = 0;
    }
    if (settings.desktopNotifications && chrome.notifications) {
      try {
        chrome.notifications.create('au_gitradar_' + room.roomId + '_' + now, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: `🔔 Sala #${room.roomId} • Atividade GitHub Detectada`,
          message: events[0].slice(0, 140),
          priority: 1
        });
      } catch (_) {}
    }
    publishBoardStateToBin(room).catch(() => {});
    persistCollabRooms();
  } else if (refsChanged) {
    publishBoardStateToBin(room).catch(() => {});
    persistCollabRooms();
  }
  return events.length;
}

async function syncRoomFilebinBucket(room, minIntervalMs = 2600) {
  if (!room) return 0;
  const now = Date.now();
  const settings = await AU_STORAGE.getSettings();

  // Always check SLA timeout readiness & poll GitHub Branch/PR Radar on active rooms!
  await checkAndAnnounceIntegrationReadiness(room);
  if (room.githubConfig && room.githubConfig.enabled) {
    await pollRoomGithubRadar(room, settings, 18000);
  }

  if (!room.filebinId) return 0;
  if (now - Number(room.lastFilebinSyncAt || 0) < minIntervalMs) return 0;
  room.lastFilebinSyncAt = now;

  const remoteFiles = await AU_INTEGRATIONS.listFilebinFiles(room.filebinId);
  if (!Array.isArray(room.ingestedChatFiles)) room.ingestedChatFiles = [];
  if (!room.ingestedBoardOps || typeof room.ingestedBoardOps !== 'object') room.ingestedBoardOps = {};
  if (!Array.isArray(room.processedVaultReqs)) room.processedVaultReqs = [];
  const seenChatSet = new Set(room.ingestedChatFiles);
  const seenVaultSet = new Set(room.processedVaultReqs);
  const effectiveToken = getActiveVaultToken(room.roomId, settings);
  let added = 0;
  let boardDirty = false;

  // Sort so real-time chat messages & board updates arrive in chronological order
  const sortedRemote = remoteFiles.slice().sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));

  for (const rf of sortedRemote) {
    const fname = String(rf.filename || '');

    // Ignore internal state / vault response files
    if (/^_?au_board_state\.json$/i.test(fname) || /^auvault_res_.*\.json$/i.test(fname) || fname === 'repo-inicial.zip') {
      continue;
    }

    // 0A. Zero-Token Credential Vault Broker Request (`auvault_req_<reqId>.json`)
    if (/^auvault_req_.*\.json$/i.test(fname)) {
      if (seenVaultSet.has(fname)) continue;
      seenVaultSet.add(fname);
      room.processedVaultReqs.push(fname);
      if (room.processedVaultReqs.length > 200) {
        room.processedVaultReqs = room.processedVaultReqs.slice(-200);
      }

      try {
        const rawBytes = await AU_INTEGRATIONS.fetchSharedFileBytes(rf.url);
        const reqObj = JSON.parse(new TextDecoder().decode(rawBytes));
        const reqId = String((reqObj && reqObj.reqId) || fname.replace(/^auvault_req_|\.json$/gi, ''));
        const slotKey = String((reqObj && reqObj.slot) || 'ag1').toLowerCase();
        const caps = ensureRoomVaultCaps(room);
        const expectedCap = caps[slotKey] || '';
        let resPayload;

        if (!expectedCap || !reqObj || reqObj.cap !== expectedCap) {
          resPayload = { ok: false, error: 'Acesso negado pelo Cofre Central: credencial/sessão revogada para este agente.' };
        } else if (!effectiveToken) {
          resPayload = { ok: false, error: 'Cofre Git sem token ativo ou sessão expirada (verifique o TTL do Cofre no Painel).' };
        } else {
          const slotIdx = Math.max(0, Number((slotKey.match(/\d+/) || [1])[0]) - 1);
          const agObj = (room.agents || [])[slotIdx] || (room.roles || [])[slotIdx] || { index: slotIdx };
          const roleForBr = {
            index: slotIdx,
            agentIndex: slotIdx + 1,
            shortTitle: agObj.name || agObj.shortTitle || `Agente ${slotIdx + 1}`,
            roleTitle: agObj.roleTitle || 'Especialista',
            isSynthesizer: Boolean(agObj.isSynthesizer),
            githubAccessLevel: agObj.githubAccessLevel || 'auto_role'
          };
          const accessLevel = AU_COLLAB.resolveEffectiveAgentAccessLevel(roleForBr, room.githubConfig || {});
          const assignedBranch =
            room.githubConfig && room.githubConfig.enabled
              ? AU_COLLAB.computeAgentBranchName(room.roomId, roleForBr, room.githubConfig)
              : `au/${room.roomId}/agent-${slotIdx + 1}`;

          const brokerArgs = Object.assign({}, reqObj.args || {});
          if (
            (reqObj.action === 'pr_ship' || reqObj.action === 'push_files') &&
            (!Array.isArray(brokerArgs.files) || brokerArgs.files.length === 0) &&
            agObj &&
            agObj.tabId &&
            accessLevel === 'push_and_pr'
          ) {
            const wsRes = await sendTabMessageGroupSafe(
              agObj.tabId,
              { type: 'AU_EXECUTE_TAB_COMMAND', command: 'export_workspace_files' },
              9000
            );
            if (wsRes && Array.isArray(wsRes.files) && wsRes.files.length > 0) {
              brokerArgs.files = wsRes.files;
              brokerArgs.snapshotStatus = wsRes.exportStatus || 'partial';
              brokerArgs.deleteMissing = wsRes.exportStatus === 'complete';
            }
          }

          try {
            const brokerData = await AU_INTEGRATIONS.github.executeVaultBrokerAction(effectiveToken, {
              action: reqObj.action,
              repo: (room.githubConfig && room.githubConfig.repo) || reqObj.repo,
              fallbackOwner: settings.githubUsername || '',
              accessLevel,
              assignedBranch,
              baseBranch: (room.githubConfig && room.githubConfig.baseBranch) || 'main',
              isSynthesizer: Boolean(agObj.isSynthesizer),
              branchMode: (room.githubConfig && room.githubConfig.branchMode) || 'branch_per_agent_pr',
              args: brokerArgs
            });
            resPayload = { ok: true, data: brokerData };
          } catch (brokerErr) {
            resPayload = { ok: false, error: brokerErr.message || String(brokerErr) };
          }

          if (resPayload && resPayload.ok && (reqObj.action === 'pr_ship' || reqObj.action === 'push_files')) {
            const d = resPayload.data || {};
            if (room.githubConfig) {
              room.githubConfig.commitsPushed = Number(room.githubConfig.commitsPushed || 0) + 1;
              if (d.commitUrl) room.githubConfig.lastCommitUrl = d.commitUrl;
              if (d.pullRequest && d.pullRequest.htmlUrl) {
                room.githubConfig.pullRequestUrl = d.pullRequest.htmlUrl;
              }
            }
            await AU_STORAGE.updateMetrics((m) => {
              m.totalGithubCommitsPushed = (m.totalGithubCommitsPushed || 0) + 1;
              if (d.pullRequest && !d.pullRequest.alreadyExisted) {
                m.totalGithubPRsCreated = (m.totalGithubPRsCreated || 0) + 1;
              }
              return m;
            });
            await appendRoomMessage(
              room,
              {
                senderType: 'github',
                senderName: 'GitHub Push',
                text:
                  `🔐 [Cofre Zero-Token] ${roleForBr.shortTitle} publicou ${d.filesCount || 0} arquivo(s) em \`${d.branch || assignedBranch}\` (@${d.shortSha || ''})` +
                  (d.pullRequest && d.pullRequest.htmlUrl ? ` • PR #${d.pullRequest.number}: ${d.pullRequest.htmlUrl}` : '')
              },
              true,
              effectiveToken
            );
            boardDirty = true;
          }
        }

        const resBytes = new TextEncoder().encode(JSON.stringify(resPayload));
        await AU_INTEGRATIONS.uploadWithFallback(resBytes, `auvault_res_${reqId}.json`, {
          primaryProvider: 'filebin',
          autoFallback: false,
          binId: room.filebinId,
          mimeType: 'application/json'
        });
        added += 1;
      } catch (_) {}
      continue;
    }

    // 0B. Shared Single-Update Assignments & Contracts Board Op (`auboard_assign_*.json` / `auboard_contract_*.json`)
    if (/^auboard_(assign|contract)_.*\.json$/i.test(fname)) {
      const fileSig = `${rf.sizeBytes || 0}_${rf.updatedAt || ''}`;
      if (room.ingestedBoardOps[fname] === fileSig) continue;
      room.ingestedBoardOps[fname] = fileSig;
      try {
        ensureRoomBoardInitialized(room);
        const rawBytes = await AU_INTEGRATIONS.fetchSharedFileBytes(rf.url);
        const opObj = JSON.parse(new TextDecoder().decode(rawBytes));
        if (opObj && opObj.op === 'assign') {
          const res = AU_COLLAB.upsertBoardAssignment(
            room.sharedBoard,
            opObj.slotKey || 'ag1',
            {
              agentName: opObj.agentName,
              status: opObj.status,
              files: opObj.files,
              notes: opObj.notes
            },
            opObj.agentName || 'Agente'
          );
          if (res.changed) boardDirty = true;
        } else if (opObj && opObj.op === 'contract' && opObj.key) {
          const res = AU_COLLAB.upsertBoardContract(
            room.sharedBoard,
            opObj.key,
            {
              spec: opObj.spec,
              status: opObj.status,
              owner: opObj.owner
            },
            opObj.owner || 'Agente'
          );
          if (res.changed) boardDirty = true;
        }
      } catch (_) {}
      continue;
    }

    // 1. Live Real-Time Agent-to-Agent Chat Message (auchat_<ts>_ag<N>_<rand>.json)
    if (/^auchat_.*\.json$/i.test(fname)) {
      if (seenChatSet.has(fname)) continue;
      seenChatSet.add(fname);
      room.ingestedChatFiles.push(fname);
      if (room.ingestedChatFiles.length > 250) {
        room.ingestedChatFiles = room.ingestedChatFiles.slice(-250);
      }
      if (/_coord_/i.test(fname) || /_gitradar_/i.test(fname)) continue;

      try {
        const rawBytes = await AU_INTEGRATIONS.fetchSharedFileBytes(rf.url);
        const msgData = JSON.parse(new TextDecoder().decode(rawBytes));
        const msgText = String((msgData && msgData.text) || '').trim();
        if (!msgText) continue;
        if (
          AU_DEFAULTS &&
          typeof AU_DEFAULTS.isSystemOrAutoPromptText === 'function' &&
          AU_DEFAULTS.isSystemOrAutoPromptText(msgText)
        ) {
          continue;
        }

        const tagStr = String((msgData && msgData.tag) || '');
        const msgTs = Number((msgData && msgData.ts) || now);

        // ARENA-18: Reject & quarantine any bucket message explicitly claiming a different roomId!
        if (msgData && msgData.roomId && String(msgData.roomId) !== String(room.roomId)) {
          room.quarantinedCrossRoomCount = Number(room.quarantinedCrossRoomCount || 0) + 1;
          continue;
        }

        // SEC-08: Verify per-room HMAC-SHA256 signature; tag unsigned/invalid messages as externalUnverified
        let externalUnverified = Boolean(msgData && msgData.externalUnverified);
        if (room.roomHmacKey && typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.verifyRoomMessage) {
          const sigHex = String((msgData && (msgData.hmacSig || msgData.sig)) || '');
          const msgIdOrSeq = String((msgData && (msgData.id || msgData.seq)) || '');
          const authorTag = tagStr || String((msgData && msgData.sender) || '');
          const validSig =
            sigHex.length >= 32 &&
            (await AU_CRED_BROKER.verifyRoomMessage(
              room.roomHmacKey,
              room.roomId,
              authorTag,
              msgTs,
              msgText,
              sigHex,
              msgIdOrSeq
            ));
          if (!validSig) {
            externalUnverified = true;
          }
        }

        const safeIncomingText = externalUnverified
          ? msgText
              .replace(/\[(?:GITHUB_PUSH_PRONTO|ENTREGA_FINAL_PRONTA|ATRIBUICAO_UNICA|CONTRATO_UNICO|VOTO_CONSENSO|ARQUIVO_COMPARTILHADO)[^\]]*\]/gi, '[TAG_NAO_VERIFICADA]')
              .trim()
          : msgText;
        if (!safeIncomingText) continue;

        const agMatch = tagStr.match(/^ag(\d+)$/i);
        const slotIdx = !externalUnverified && agMatch ? Number(agMatch[1]) - 1 : -1;
        const slotAgent = slotIdx >= 0 && Array.isArray(room.agents) ? room.agents[slotIdx] : null;

        // Enforce Anti-Thinking Team Admission Gate on live messages too!
        if (room.refuseThinkingModels !== false && slotAgent) {
          if (slotAgent.screeningStatus === 'refused_stopped') continue;
          if (slotAgent.screeningStatus === 'rerolling' && msgTs < Number(slotAgent.lastScreeningAt || 0)) {
            continue;
          }
          if (!slotAgent.admittedToTeam && slotAgent.tabId) {
            const probe = await sendTabMessageGroupSafe(
              slotAgent.tabId,
              { type: 'AU_CHECK_TAB_HAS_THINKING', stopOnDetect: true },
              1400
            );
            if (probe && probe.hasThinking) {
              continue;
            }
            slotAgent.admittedToTeam = true;
            slotAgent.screeningStatus = 'admitted';
            await appendRoomMessage(
              room,
              {
                senderType: 'system',
                senderName: 'Time Anti-Thinking',
                text: `✅ ${slotAgent.name} confirmado sem Thinking e adicionado ao Time em tempo real!`
              },
              false
            );
          }
        }

        const inserted = await appendRoomMessage(
          room,
          {
            senderType: externalUnverified ? 'external' : 'agent',
            senderName: externalUnverified
              ? `⛔ ${(msgData && msgData.sender) || 'Fonte externa não verificada'}`
              : `⚡ ${(msgData && msgData.sender) || (slotAgent && slotAgent.name) || 'Agente'}`,
            senderRole: externalUnverified
              ? 'Não Verificado (sem assinatura HMAC)'
              : (msgData && msgData.role) || (slotAgent && slotAgent.roleTitle) || '',
            externalUnverified,
            tabId: slotAgent ? slotAgent.tabId : null,
            text: safeIncomingText
          },
          !externalUnverified,
          effectiveToken
        );

        if (inserted) {
          added += 1;
          wakeWaitingPeersInRoom(room, slotAgent ? slotAgent.tabId : null);
        }
      } catch (_) {}
      continue;
    }

    // 2. Shared Deliverable / Code / Zip Artifact
    if (
      registerSharedFileInRoom(room, {
        filename: fname,
        provider: 'Filebin.net',
        sizeBytes: rf.sizeBytes,
        url: rf.url,
        uploadedBy: 'Bucket Filebin'
      })
    ) {
      added += 1;
    }
  }

  if (boardDirty) {
    await checkAndAnnounceIntegrationReadiness(room);
    await publishBoardStateToBin(room);
    notifyLiveChatRoomDelta(room, null);
    wakeWaitingPeersInRoom(room, null);
    added += 1;
  }

  if (added > 0) {
    persistCollabRooms();
  }
  return added;
}

let realtimeRoomsSyncInFlight = false;
async function syncAllActiveCollabRoomsRealtime() {
  if (realtimeRoomsSyncInFlight || COLLAB_ROOMS.size === 0) return;
  realtimeRoomsSyncInFlight = true;
  try {
    for (const room of COLLAB_ROOMS.values()) {
      if (room.status === 'active') {
        await syncRoomFilebinBucket(room, 2600);
      }
    }
  } catch (_) {
  } finally {
    realtimeRoomsSyncInFlight = false;
  }
}

async function resolveAndPersistGithubInput(opts = {}, settings = {}) {
  const rawRepo = String(opts.repo ?? opts.githubRepo ?? settings.githubDefaultRepo ?? '').trim();
  const inlineToken = AU_INTEGRATIONS.normalizeGithubToken(opts.token ?? opts.githubToken ?? '');
  const spec = AU_INTEGRATIONS.parseGitRepoSpec(rawRepo, settings.githubUsername || '');
  const effectiveToken = AU_INTEGRATIONS.normalizeGithubToken(
    inlineToken || (spec && spec.embeddedToken) || SESSION_GLOBAL_GITHUB_TOKEN || ''
  );

  // SEC-02 + ARENA-16: Persist inline token strictly in volatile storage.session (NEVER in settings on storage.local!)
  if (inlineToken && inlineToken !== SESSION_GLOBAL_GITHUB_TOKEN) {
    await setGlobalVaultToken(inlineToken);
  } else if (!SESSION_GLOBAL_GITHUB_TOKEN && spec && spec.embeddedToken) {
    await setGlobalVaultToken(spec.embeddedToken);
  }
  if (spec && rawRepo && rawRepo !== settings.githubDefaultRepo) {
    await AU_STORAGE.saveSettings({
      githubDefaultRepo: spec.webUrl || spec.fullName
    }).catch(() => {});
  }

  let effectiveBaseBranch = String(
    opts.baseBranch ?? opts.githubBaseBranch ?? (spec && spec.branchFromUrl) ?? settings.githubBaseBranch ?? 'main'
  ).trim() || 'main';
  if (
    spec &&
    spec.branchFromUrl &&
    (!opts.baseBranch && !opts.githubBaseBranch || (opts.githubBaseBranch === 'main' && rawRepo.includes('/tree/')))
  ) {
    effectiveBaseBranch = spec.branchFromUrl;
  }

  return {
    spec,
    rawRepo,
    canonicalRepo: spec ? spec.webUrl || spec.fullName : rawRepo,
    fullName: spec ? spec.fullName : rawRepo,
    effectiveToken,
    effectiveBaseBranch
  };
}

// ARENA-08 + SEC-06: Private repositories default to Browser-Direct CAS Proxy (ZERO external host upload!).
// External upload is ONLY performed if explicitly opted in AND encrypted with AES-256-GCM (AUE1 magic bytes != PK).
async function stageRepoSnapshotForProxyIfNeeded(githubCfg, token, binId) {
  if (!githubCfg || !githubCfg.enabled || !token) {
    return '';
  }
  const mode = AU_DEFAULTS.normalizeGithubAuthMode(githubCfg.authMode);
  if (mode !== 'extension_proxy_push' && mode !== 'vault_broker_zero_token') {
    return '';
  }
  try {
    const access = await AU_INTEGRATIONS.github.checkRepoAccess(token, githubCfg.repo).catch(() => null);
    const isPrivate = !access || !access.ok || Boolean(access.private);

    if (isPrivate) {
      const allowExt = Boolean(githubCfg.allowExternalPrivateRepoUpload);
      const passphrase = String(githubCfg.privateSnapshotPassphrase || '').trim();
      if (!allowExt || !passphrase) {
        if (typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.appendSecurityAuditLog) {
          AU_CRED_BROKER.appendSecurityAuditLog({
            category: 'private_repo_cas_direct',
            action: 'skip_external_upload',
            target: githubCfg.repo || '',
            detail: 'Private repo routed via browser-direct CAS proxy (zero external upload)'
          }).catch(() => {});
        }
        return '';
      }
      const zipBytes = await AU_INTEGRATIONS.github.downloadRepoZipBytes(
        token,
        githubCfg.repo,
        githubCfg.baseBranch || ''
      );
      if (!zipBytes || zipBytes.byteLength < 22 || zipBytes.byteLength > 45 * 1024 * 1024) {
        return '';
      }
      const encryptedBytes = await AU_CRED_BROKER.encryptBinaryBundle(zipBytes, passphrase);
      const uploaded = await AU_INTEGRATIONS.uploadWithFallback(encryptedBytes, 'repo-inicial.zip.aue1', {
        primaryProvider: 'filebin',
        autoFallback: true,
        expiry: '1h',
        mimeType: 'application/octet-stream',
        binId: binId || AU_INTEGRATIONS.generateFilebinId('ghinit')
      });
      return (uploaded && uploaded.url) || '';
    }

    // Public repos clone directly via `git clone` without needing any external snapshot upload!
    return '';
  } catch (_) {
    return '';
  }
}

// PROD-14: Pre-PR Quality Gate (checks non-empty diff, secret leaks, conflict markers, and JSON validity)
function runPrePrQualityGate(files = []) {
  const issues = [];
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, issues: ['Nenhum arquivo presente para validação.'] };
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (const f of files) {
    if (!f || !f.path || f.mode === '120000') continue;
    let txt = '';
    if (typeof f.content === 'string') {
      txt = f.content;
    } else if (typeof f.base64 === 'string' && f.base64.length < 512000) {
      try {
        txt = decoder.decode(AU_INTEGRATIONS.base64ToUint8(f.base64));
      } catch (_) {}
    } else if (f.bytes instanceof Uint8Array && f.bytes.byteLength < 512000) {
      try {
        txt = decoder.decode(f.bytes);
      } catch (_) {}
    }
    if (!txt) continue;

    if (typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.containsSecret && AU_CRED_BROKER.containsSecret(txt)) {
      issues.push(`Credencial/token sensível detectado em ${f.path}`);
    }
    if (/^<{7}\s|^={7}$|^>{7}\s/m.test(txt)) {
      issues.push(`Marcadores de conflito Git não resolvidos em ${f.path}`);
    }
    if (/\.json$/i.test(f.path) && !/tsconfig|jsconfig/i.test(f.path) && txt.trim().length > 0) {
      try {
        JSON.parse(txt);
      } catch (e) {
        issues.push(`JSON inválido em ${f.path}: ${(e && e.message) || 'erro de sintaxe'}`);
      }
    }
  }
  return {
    ok: issues.length === 0,
    checkedCount: files.length,
    issues
  };
}

async function pushArchiveOrWorkspaceToGithub(opts = {}) {
  const settings = await AU_STORAGE.getSettings();
  const resolved = await resolveAndPersistGithubInput(opts, settings);
  const token = resolved.effectiveToken;
  if (!token) {
    throw new Error(
      'Para enviar commits/PR ao GitHub, informe seu Personal Access Token (PAT: ghp_... ou github_pat_...) no Cofre.'
    );
  }
  if (!resolved.spec) {
    throw new Error(
      'Informe o link do repositório GitHub (https://github.com/usuario/repositorio) ou usuario/repositorio.'
    );
  }
  const repo = resolved.spec.fullName;

  let filesToCommit = Array.isArray(opts.files) ? opts.files.slice() : [];
  let snapshotStatus = opts.snapshotStatus || (filesToCommit.length > 0 ? 'partial' : 'failed');
  let omittedList = [];
  let archiveErr = null;

  // Option A: Unpack from a shared TempFile URL (.zip or single file)
  if (!filesToCommit.length && opts.archiveUrl) {
    try {
      const rawBytes = await AU_INTEGRATIONS.fetchSharedFileBytes(opts.archiveUrl);
      const lowerUrl = opts.archiveUrl.toLowerCase();
      if (lowerUrl.endsWith('.zip') || (rawBytes.length > 4 && rawBytes[0] === 0x50 && rawBytes[1] === 0x4b)) {
        const extractedZip = await AU_INTEGRATIONS.extractZipArchive(rawBytes, {
          stripSingleRoot: true,
          preferRepoSubdir: true,
          returnMeta: true
        });
        if (Array.isArray(extractedZip)) {
          filesToCommit = extractedZip;
          snapshotStatus = 'complete';
        } else if (extractedZip && Array.isArray(extractedZip.files)) {
          filesToCommit = extractedZip.files;
          omittedList = Array.isArray(extractedZip.omitted) ? extractedZip.omitted : [];
          snapshotStatus = extractedZip.status || (omittedList.length > 0 ? 'partial' : 'complete');
        }
      } else if (rawBytes && rawBytes.length > 0) {
        const fname = AU_INTEGRATIONS.sanitizeFilename(opts.filename || opts.archiveUrl.split('/').pop() || 'entrega.txt');
        filesToCommit = [{ path: fname, bytes: rawBytes }];
        snapshotStatus = 'partial';
      }
    } catch (e) {
      archiveErr = e;
      if (!opts.tabId) throw e;
    }
  }

  // Option B: Export Agent Workspace (.zip OR live CAS Manifest) via authenticated Arena tab
  if (!filesToCommit.length && opts.tabId) {
    const tabIdNum = Number(opts.tabId);
    const tab = await chrome.tabs.get(tabIdNum);
    const rawUrl = (tab && tab.url) || '';
    if (!rawUrl || !/\/(agent|c)\/[A-Za-z0-9_-]+/i.test(rawUrl)) {
      if (archiveErr) throw archiveErr;
      throw new Error('Esta aba ainda não possui um Workspace salvo no Arena.ai.');
    }

    const tabWsRes = await sendTabMessageGroupSafe(
      tabIdNum,
      {
        type: 'AU_EXECUTE_TAB_COMMAND',
        command: 'export_workspace_files',
        payload: { preferRepoSubdir: true }
      },
      26000
    );

    if (tabWsRes && tabWsRes.ok) {
      snapshotStatus = tabWsRes.exportStatus || 'complete';
      omittedList = Array.isArray(tabWsRes.omitted) ? tabWsRes.omitted : [];
      if (tabWsRes.mode === 'cas' && Array.isArray(tabWsRes.files) && tabWsRes.files.length > 0) {
        filesToCommit = tabWsRes.files;
      } else if (tabWsRes.mode === 'zip' && tabWsRes.base64Zip) {
        const zipBytes = AU_INTEGRATIONS.base64ToUint8(tabWsRes.base64Zip);
        filesToCommit = await AU_INTEGRATIONS.extractZipArchive(zipBytes, {
          stripSingleRoot: true,
          preferRepoSubdir: true
        });
      }
    }

    if (!filesToCommit.length) {
      try {
        const cleanUrl = rawUrl.split('?')[0].replace(/\/+$/, '');
        const zipBytes = await AU_INTEGRATIONS.fetchSharedFileBytes(cleanUrl + '/download-workspace');
        filesToCommit = await AU_INTEGRATIONS.extractZipArchive(zipBytes, {
          stripSingleRoot: true,
          preferRepoSubdir: true
        });
        snapshotStatus = 'complete';
      } catch (_) {
        if (archiveErr) throw archiveErr;
        throw new Error('O Workspace deste agente ainda está vazio no Arena.ai (nenhum arquivo criado em /home/user).');
      }
    }
  }

  if (!filesToCommit.length) {
    throw new Error('Nenhum arquivo encontrado no pacote/workspace para commitar.');
  }

  // DATA-03 + ARENA-15: Emit .au-manifest.json when snapshot export is partial so omitted files are audited
  if (snapshotStatus === 'partial' && omittedList.length > 0 && !filesToCommit.some((f) => f.path === '.au-manifest.json')) {
    filesToCommit.push({
      path: '.au-manifest.json',
      content: JSON.stringify(
        {
          status: 'partial',
          generatedAt: new Date().toISOString(),
          includedCount: filesToCommit.length,
          omittedCount: omittedList.length,
          omitted: omittedList.slice(0, 100)
        },
        null,
        2
      )
    });
  }

  // PROD-14: Run Pre-PR Quality Gate when enabled
  const qGate = runPrePrQualityGate(filesToCommit);
  if (!qGate.ok && settings.prePrQualityGate !== false && opts.bypassQualityGate !== true) {
    throw new Error(`Quality Gate bloqueou o envio: ${qGate.issues.slice(0, 3).join(' | ')}`);
  }

  const baseBranch = (opts.baseBranch || resolved.effectiveBaseBranch || settings.githubBaseBranch || 'main').trim();
  let branch = (opts.branch || baseBranch).trim();
  if (opts.openPR && (!branch || branch === baseBranch)) {
    branch = `au/pr-${Date.now().toString(36)}`;
  }
  const commitRes = await AU_INTEGRATIONS.github.pushFilesCommit(token, {
    repo,
    branch,
    baseBranch,
    snapshotStatus,
    deleteMissing: snapshotStatus === 'complete' && opts.deleteMissing !== false,
    message: opts.message || `feat: atualização enviada via Arena Ultra (${filesToCommit.length} arquivos)`,
    files: filesToCommit
  });

  await AU_STORAGE.updateMetrics((m) => {
    m.totalGithubCommitsPushed = (m.totalGithubCommitsPushed || 0) + 1;
    return m;
  });

  let prRes = null;
  const resolvedBaseForPr = (commitRes.baseBranch || baseBranch).trim();
  if (opts.openPR && branch !== resolvedBaseForPr) {
    const partialNote =
      snapshotStatus === 'partial'
        ? `\n\n> ⚠️ **Exportação Parcial (\`.au-manifest.json\`)**: ${omittedList.length} item(ns) omitido(s); deleções automáticas (\`sha: null\`) foram desativadas por segurança.`
        : '';
    prRes = await AU_INTEGRATIONS.github.createPullRequest(token, {
      repo: commitRes.repo,
      head: branch,
      base: resolvedBaseForPr,
      title: opts.prTitle || `🚀 Entrega Automática (${branch})`,
      body:
        (opts.prBody ||
          `Commit \`${commitRes.shortSha}\` com ${commitRes.filesCount} arquivos gerado automaticamente via Arena Ultra (Browser-Direct CAS).`) +
        partialNote
    });
    if (prRes && !prRes.alreadyExisted) {
      await AU_STORAGE.updateMetrics((m) => {
        m.totalGithubPRsCreated = (m.totalGithubPRsCreated || 0) + 1;
        return m;
      });
    }
  }

  return Object.assign({}, commitRes, { snapshotStatus, qualityGate: qGate, pullRequest: prRes });
}

async function createCollabRoom(opts = {}) {
  await ensureCollabRoomsLoaded();
  const settings = await AU_STORAGE.getSettings();
  const roomId = AU_COLLAB.generateFourDigitCode(new Set(COLLAB_ROOMS.keys()));
  const profile = opts.profile || 'specialists';
  const stopMode = opts.stopMode || 'smart_consensus';
  const agentCount = Math.max(1, Number(opts.agentCount || 3));
  const roles = AU_COLLAB.buildTeamRoles(agentCount, profile);
  const filebinId = AU_INTEGRATIONS.generateFilebinId(roomId);
  const roomHmacKey =
    typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.generateRoomHmacKeyHex
      ? AU_CRED_BROKER.generateRoomHmacKeyHex()
      : '';

  const ghResolved = opts.githubEnabled ? await resolveAndPersistGithubInput(opts, settings) : null;
  if (ghResolved && ghResolved.effectiveToken) {
    ROOM_GITHUB_TOKENS.set(roomId, ghResolved.effectiveToken);
    persistVolatileWorkerState();
  }
  const ghEnabled = Boolean(opts.githubEnabled && ghResolved && ghResolved.spec);
  const defaultAgentAccessMode =
    opts.githubDefaultAgentAccessMode || settings.githubDefaultAgentAccessMode || 'auto_role';
  const githubConfig = ghEnabled
    ? {
        enabled: true,
        repo: ghResolved.canonicalRepo,
        fullName: ghResolved.fullName,
        baseBranch: ghResolved.effectiveBaseBranch,
        authMode: AU_DEFAULTS.normalizeGithubAuthMode(opts.githubAuthMode || settings.githubAuthMode),
        branchMode: opts.githubBranchMode || settings.githubBranchMode || 'branch_per_agent_pr',
        sharedBranch: String(opts.githubSharedBranch || `au/tempchat-${roomId}`).trim(),
        defaultAgentAccessMode,
        qaReadOnly: Boolean(settings.githubQaReadOnly),
        repoSnapshotUrl: String(opts.repoSnapshotUrl || '').trim(),
        commitsPushed: 0,
        lastCommitUrl: '',
        pullRequestUrl: ''
      }
    : null;

  const profileMeta = (AU_DEFAULTS.COLLAB_PROFILES && AU_DEFAULTS.COLLAB_PROFILES[profile]) || { label: profile };
  const stopMeta = (AU_DEFAULTS.COLLAB_STOP_MODES && AU_DEFAULTS.COLLAB_STOP_MODES[stopMode]) || { label: stopMode };
  const nowTs = Date.now();
  const integrationTimeoutMinutes = Math.max(
    3,
    Number(opts.integrationTimeoutMinutes || settings.collabIntegrationTimeoutMinutes || 25)
  );
  const maxRoundsBeforeSynthesis = Math.max(
    2,
    Number(opts.maxRoundsBeforeSynthesis || settings.collabMaxRoundsBeforeSynthesis || 6)
  );
  const sharedBoard = AU_COLLAB.createInitialSharedBoard(roles, roomId, githubConfig);

  // ARENA-11: Single-screen Task Authorization Policy bound to the room
  const taskPolicy = Object.assign(
    {
      authorizedAt: nowTs,
      autoMode: settings.taskAutoAuthorizePermanent !== false,
      maxRounds: Number(settings.maxLoopsPerTask || 25),
      maxCommits: Number(settings.maxCommitsPerTask || 15),
      maxPrs: Number(settings.maxPrsPerTask || 5),
      maxUploads: Number(settings.maxUploadsPerTask || 30),
      maxMinutes: integrationTimeoutMinutes * 2
    },
    opts.taskPolicy && typeof opts.taskPolicy === 'object' ? opts.taskPolicy : {}
  );

  const room = {
    roomId,
    roomHmacKey,
    agentKitEnabled: settings.agentKitEnabled === true,
    harness: settings.harnessEnabled !== false ? AU_HARNESS.fresh() : null,
    leaderEpoch: 1,
    createdAt: nowTs,
    updatedAt: nowTs,
    status: 'active', // 'active' | 'paused' | 'needs_human' | 'completed' | 'closed'
    profile,
    stopMode,
    taskPolicy,
    integrationTimeoutMinutes,
    integrationDeadlineAt: nowTs + integrationTimeoutMinutes * 60000,
    maxRoundsBeforeSynthesis,
    forceReadyForSynthesis: false,
    lastAnnouncedIntegrationState: '',
    deduplicatedMessagesCount: 0,
    quarantinedCrossRoomCount: 0,
    sharedBoard,
    ingestedBoardOps: {},
    processedVaultReqs: [],
    gitRadarBaselineDone: false,
    lastGitRadarPollAt: 0,
    refuseThinkingModels:
      opts.refuseThinkingModels !== undefined
        ? Boolean(opts.refuseThinkingModels)
        : settings.refuseThinkingModels !== false,
    baseTask: String(opts.baseTask || '').trim(),
    mirrorExternal: Boolean(opts.mirrorExternal),
    externalTabId: null,
    externalCode: '',
    filebinId,
    lastFilebinSyncAt: 0,
    sharedFiles: [],
    githubConfig,
    seq: 0,
    roles,
    agents: [],
    messages: [],
    finalDeliverable: '',
    finalBy: ''
  };

  COLLAB_ROOMS.set(roomId, room);
  ensureRoomVaultCaps(room);
  publishBoardStateToBin(room).catch(() => {});
  const ghBanner = githubConfig ? ` • GitHub: ${githubConfig.repo} (${githubConfig.branchMode})` : '';
  const filterBanner = room.refuseThinkingModels ? ' • 🚫 Filtro Anti-Thinking Ativo (só modelos sem Thinking entram no time)' : '';
  await appendRoomMessage(
    room,
    {
      senderType: 'system',
      senderName: 'TempChat',
      text: `Sala TempChat #${roomId} criada • Dinâmica: ${profileMeta.label} • Conclusão: ${stopMeta.label} • Bucket Filebin: ${filebinId}${ghBanner}${filterBanner}`
    },
    false
  );

  await AU_STORAGE.updateMetrics((m) => {
    m.totalCollabRoomsCreated = (m.totalCollabRoomsCreated || 0) + 1;
    return m;
  });

  if (room.mirrorExternal || opts.joinExternalCode) {
    await openExternalTempChatBridgeTab(room, opts.joinExternalCode || '');
  }

  persistCollabRooms(true);
  return room;
}

// ARENA-05: Automatic Synthesizer Leader Health Monitor & Monotonic leaderEpoch Failover
function ensureHealthySynthesizerLeader(room) {
  if (!room || !Array.isArray(room.agents) || room.agents.length === 0) return null;
  if (!room.leaderEpoch || room.leaderEpoch < 1) room.leaderEpoch = 1;

  const isAgentHealthy = (ag) => {
    if (!ag || ag.closed || ag.screeningStatus === 'refused_stopped') return false;
    const pst = ag.tabId ? TAB_STATES.get(ag.tabId) : null;
    if (!pst) return true;
    if (pst.status === 'token_stopped' || pst.status === 'thinking_refused' || pst.status === 'error') {
      return false;
    }
    return true;
  };

  let currentLeader = room.agents.find((a) => a && a.isSynthesizer);
  if (currentLeader && isAgentHealthy(currentLeader)) {
    return currentLeader;
  }

  const candidates = room.agents.filter((a) => a !== currentLeader && isAgentHealthy(a) && a.admittedToTeam !== false);
  const fallbackPool = candidates.length > 0 ? candidates : room.agents.filter((a) => a !== currentLeader && isAgentHealthy(a));

  if (fallbackPool.length > 0) {
    const nextLeader = fallbackPool[fallbackPool.length - 1];
    for (const ag of room.agents) {
      ag.isSynthesizer = ag === nextLeader;
    }
    room.leaderEpoch = Number(room.leaderEpoch || 1) + 1;
    const prevName = currentLeader ? currentLeader.name : 'Sintetizador anterior';
    appendRoomMessageNow(
      room,
      {
        senderType: 'system',
        senderName: 'Failover de Líder',
        text: `🔁 Líder trocado (Epoch #${room.leaderEpoch}): ${prevName} ficou indisponível → ${nextLeader.name} assumiu automaticamente a Síntese Final.`
      },
      true
    );
    persistCollabRooms();
    return nextLeader;
  }

  if (room.agents.length > 0 && room.agents.every((a) => !isAgentHealthy(a)) && room.status === 'active') {
    room.status = 'needs_human';
    room.needsHumanReason = 'Todos os agentes elegíveis para síntese pararam ou atingiram limite.';
    appendRoomMessageNow(
      room,
      {
        senderType: 'system',
        senderName: 'Governança Autônoma',
        text: `⏸ Sala pausada em [PRECISA DE VOCÊ]: nenhum agente saudável disponível para assumir a liderança de síntese.`
      },
      false
    );
    persistCollabRooms(true);
  }
  return null;
}

async function handleCollabTurnCompleted(tabId, payload = {}) {
  await ensureCollabRoomsLoaded();
  const st = TAB_STATES.get(tabId);

  // ARENA-18: SW TAB_STATES is the ONLY authority for room membership!
  // Never trust payload.roomId from a tab that is unbound or bound to another room.
  const authoritativeRoomId = st && st.collabRoomId ? String(st.collabRoomId) : '';
  if (!authoritativeRoomId) {
    return { ok: true, action: 'fallback_normal' };
  }
  if (payload && payload.roomId && String(payload.roomId) !== authoritativeRoomId) {
    const targetLeakRoom = COLLAB_ROOMS.get(String(payload.roomId));
    if (targetLeakRoom) {
      targetLeakRoom.quarantinedCrossRoomCount = Number(targetLeakRoom.quarantinedCrossRoomCount || 0) + 1;
      persistCollabRooms();
    }
    return { ok: true, action: 'fallback_normal', rejectedCrossRoom: true };
  }

  const room = COLLAB_ROOMS.get(authoritativeRoomId);
  if (!room || room.status === 'closed') {
    return { ok: true, action: 'fallback_normal' };
  }

  if (room.status === 'completed') {
    return {
      ok: true,
      action: 'stop_completed',
      roomId: room.roomId,
      reason: `Entrega Final Consolidada pronta na Sala TempChat #${room.roomId}`
    };
  }

  if (room.status === 'paused' || room.status === 'needs_human') {
    return {
      ok: true,
      action: 'wait_peers',
      roomId: room.roomId,
      reason:
        room.status === 'needs_human'
          ? room.needsHumanReason || 'Sala aguardando decisão humana excepcional'
          : 'Sala TempChat pausada pelo Coordenador'
    };
  }

  // ARENA-18: Strict membership check — NEVER auto-append unknown tabIds into room.agents!
  const agent = (room.agents || []).find((a) => a.tabId === tabId);
  if (!agent) {
    room.quarantinedCrossRoomCount = Number(room.quarantinedCrossRoomCount || 0) + 1;
    persistCollabRooms();
    return { ok: true, action: 'fallback_normal', rejectedUnregisteredTab: true };
  }

  // ARENA-18: Reject stale bindingEpoch messages from earlier room bindings on the same tab
  if (
    payload.bindingEpoch &&
    agent.bindingEpoch &&
    Number(payload.bindingEpoch) !== Number(agent.bindingEpoch)
  ) {
    room.quarantinedCrossRoomCount = Number(room.quarantinedCrossRoomCount || 0) + 1;
    return { ok: true, action: 'fallback_normal', rejectedStaleEpoch: true };
  }

  agent.closed = false;
  ensureHealthySynthesizerLeader(room);
  if (room.status === 'needs_human') {
    return { ok: true, action: 'wait_peers', roomId: room.roomId, reason: room.needsHumanReason };
  }

  ensureRoomBoardInitialized(room);
  const slotKey = `ag${Number(agent.index || 0) + 1}`;
  const roomVaultCaps = ensureRoomVaultCaps(room);

  const settings = await AU_STORAGE.getSettings();
  const effectiveRoomToken = getActiveVaultToken(room.roomId, settings);


  // ARENA-11: Check room task policy budget limits (rounds / elapsed time) -> pause into needs_human on hard budget exhaustion
  if (room.taskPolicy) {
    const maxR = Number(room.taskPolicy.maxRounds || settings.maxLoopsPerTask || 0);
    if (maxR > 0 && Number(agent.turnsCount || 0) >= maxR) {
      room.status = 'needs_human';
      room.needsHumanReason = `Orçamento de rodadas da tarefa atingido (${maxR} turnos em ${agent.name}).`;
      await appendRoomMessage(
        room,
        {
          senderType: 'system',
          senderName: 'Orçamento da Tarefa',
          text: `⏸ Orçamento de ${maxR} rodadas atingido por ${agent.name}. Sala em [PRECISA DE VOCÊ] para autorizar mais rodadas ou concluir.`
        },
        false
      );
      persistCollabRooms(true);
      await refreshExtensionBadge();
      return { ok: true, action: 'wait_peers', roomId: room.roomId, reason: room.needsHumanReason };
    }
  }

  // Safety gate: if this tab reported a Thinking indicator while room's Anti-Thinking filter is ON, refuse & re-roll immediately instead of admitting to the Team!
  if (room.refuseThinkingModels !== false && payload.thinkingIndicator) {
    return await handleThinkingModelRefused(tabId, {
      indicator: payload.thinkingIndicator,
      collabRoomId: room.roomId,
      collabAgentName: agent.name,
      autoContinueEnabled: true
    });
  }

  // Official Team Admission Gate: only when the model responds WITHOUT showing "Thinking..." / "Thought for..." is it added to the Team!
  if (agent.admittedToTeam === false) {
    agent.admittedToTeam = true;
    agent.screeningStatus = 'admitted';
    await appendRoomMessage(
      room,
      {
        senderType: 'system',
        senderName: 'Time Anti-Thinking',
        text: `✅ ${agent.name} (${agent.roleTitle}) respondeu direto SEM Thinking${agent.refusedCount > 0 ? ` (após recusar ${agent.refusedCount} modelo(s))` : ''} e foi adicionado oficialmente ao Time!`
      },
      false,
      effectiveRoomToken
    );
    persistCollabRooms();
  }

  const rawAssistantText = String(payload.assistantText || '').trim();
  const scrubbedAssistantText =
    typeof AU_ARENA_ADAPTER !== 'undefined' && AU_ARENA_ADAPTER.scrubSerializedReasoning
      ? AU_ARENA_ADAPTER.scrubSerializedReasoning(rawAssistantText).text
      : rawAssistantText;
  const assistantText =
    scrubbedAssistantText &&
    !(AU_DEFAULTS && typeof AU_DEFAULTS.isSystemOrAutoPromptText === 'function' && AU_DEFAULTS.isSystemOrAutoPromptText(scrubbedAssistantText))
      ? scrubbedAssistantText
      : '';
  if (assistantText) {
    const turnHash = AU_COLLAB.quickHash(assistantText);
    if (agent.lastTurnHash !== turnHash) {
      if (room.agentKitEnabled) AU_AGENT_KIT.observe(room, agent, assistantText);
      if (room.harness) AU_HARNESS.observe(room, agent, AU_CRED_BROKER.scrubSecrets(assistantText, effectiveRoomToken));
      agent.lastTurnHash = turnHash;
      agent.turnsCount = Number(agent.turnsCount || 0) + 1;
      agent.cliBootstrapped = true;
      agent.waitingSince = 0;

      const extracted = AU_COLLAB.extractTempChatShare(assistantText, effectiveRoomToken, {
        slotKey,
        authorName: agent.name
      });

      // ARENA-12: Persist explicit consensus vote when emitted ([VOTO_CONSENSO: APROVO|BLOQUEIO ...])
      if (extracted.consensusVote) {
        agent.consensusVote = extracted.consensusVote;
      }

      // Apply single-update Shared Board updates emitted in the agent's reply
      let boardChangedInTurn = false;
      if (extracted.boardUpdates) {
        for (const aUp of extracted.boardUpdates.assignments || []) {
          const r = AU_COLLAB.upsertBoardAssignment(
            room.sharedBoard,
            aUp.slotKey || slotKey,
            {
              agentName: agent.name,
              status: aUp.status,
              files: aUp.files,
              branch: aUp.branch,
              notes: aUp.notes
            },
            agent.name
          );
          if (r.changed) boardChangedInTurn = true;
        }
        for (const cUp of extracted.boardUpdates.contracts || []) {
          const r = AU_COLLAB.upsertBoardContract(
            room.sharedBoard,
            cUp.key,
            {
              spec: cUp.spec,
              status: cUp.status,
              owner: cUp.owner || agent.name
            },
            agent.name
          );
          if (r.changed) boardChangedInTurn = true;
        }
      }
      if (boardChangedInTurn) {
        await checkAndAnnounceIntegrationReadiness(room);
        publishBoardStateToBin(room).catch(() => {});
      }

      // Register any temporary files shared by this Agent in this turn
      let latestZipUrl = '';
      if (Array.isArray(extracted.sharedFiles) && extracted.sharedFiles.length > 0) {
        for (const sf of extracted.sharedFiles) {
          registerSharedFileInRoom(room, {
            filename: sf.filename,
            provider: sf.provider,
            url: sf.url,
            uploadedBy: agent.name
          });
          if (/\.zip$/i.test(sf.url) || /\.zip$/i.test(sf.filename || '')) {
            latestZipUrl = sf.url;
          }
        }
      }

      // Record any GitHub PR / Commit URLs reported in vault_broker_zero_token or extension_proxy_push mode
      let reportedPrInTurn = false;
      if (room.githubConfig && Array.isArray(extracted.githubUrls) && extracted.githubUrls.length > 0) {
        for (const gu of extracted.githubUrls) {
          if (gu.includes('/pull/')) {
            room.githubConfig.pullRequestUrl = gu;
            reportedPrInTurn = true;
          }
          if (gu.includes('/commit/')) room.githubConfig.lastCommitUrl = gu;
        }
      }

      const roleForBranch = {
        agentIndex: agent.index + 1,
        index: agent.index,
        shortTitle: agent.name,
        roleTitle: agent.roleTitle,
        isSynthesizer: agent.isSynthesizer,
        githubAccessLevel: agent.githubAccessLevel || 'auto_role'
      };
      const effectiveAgentAccess = AU_COLLAB.resolveEffectiveAgentAccessLevel(roleForBranch, room.githubConfig || {});
      const canAgentWriteGit = effectiveAgentAccess !== 'revoked' && effectiveAgentAccess !== 'read_only';
      const canAgentOpenPR = effectiveAgentAccess === 'push_and_pr';
      const normalizedRoomAuthMode = room.githubConfig
        ? AU_DEFAULTS.normalizeGithubAuthMode(room.githubConfig.authMode)
        : 'vault_broker_zero_token';

      // Automatic Extension-Side GitHub Commit + PR when [GITHUB_PUSH_PRONTO] is emitted (Browser-Direct CAS + Zero-Token Vault!)
      if (
        room.githubConfig &&
        room.githubConfig.enabled &&
        canAgentWriteGit &&
        !reportedPrInTurn &&
        (extracted.githubPushReadyMessage ||
          ((normalizedRoomAuthMode === 'extension_proxy_push' ||
            normalizedRoomAuthMode === 'vault_broker_zero_token') &&
            (latestZipUrl || extracted.isFinalReady))) &&
        effectiveRoomToken
      ) {
        try {
          const targetBranch = AU_COLLAB.computeAgentBranchName(room.roomId, roleForBranch, room.githubConfig);
          const shouldOpenPR =
            canAgentOpenPR &&
            settings.githubAutoCreatePR !== false &&
            (room.githubConfig.branchMode === 'branch_per_agent_pr' || targetBranch !== room.githubConfig.baseBranch);

          const pushRes = await pushArchiveOrWorkspaceToGithub({
            token: effectiveRoomToken,
            repo: room.githubConfig.repo,
            baseBranch: room.githubConfig.baseBranch,
            branch: targetBranch,
            archiveUrl: latestZipUrl || '',
            tabId,
            message:
              extracted.githubPushReadyMessage ||
              `feat(${agent.name}): entrega colaborativa Sala TempChat #${room.roomId}`,
            openPR: shouldOpenPR,
            prTitle: agent.isSynthesizer
              ? `🤝 Entrega Consolidada Sala TempChat #${room.roomId}`
              : `🚀 [${agent.name}] Entrega Autônoma Sala #${room.roomId}`,
            prBody: `Entrega gerada automaticamente na Sala TempChat #${room.roomId} por **${agent.name}** (${agent.roleTitle}).`
          });

          room.githubConfig.commitsPushed = Number(room.githubConfig.commitsPushed || 0) + 1;
          room.githubConfig.lastCommitUrl = pushRes.commitUrl || '';
          if (pushRes.pullRequest && pushRes.pullRequest.htmlUrl) {
            room.githubConfig.pullRequestUrl = pushRes.pullRequest.htmlUrl;
            reportedPrInTurn = true;
          }
          await appendRoomMessage(
            room,
            {
              senderType: 'system',
              senderName: 'GitHub Push',
              text:
                `🐙 Commit ${pushRes.shortSha} enviado automaticamente para ${pushRes.repo}@${pushRes.branch} (${pushRes.filesCount} arquivos)` +
                (pushRes.pullRequest ? ` • PR #${pushRes.pullRequest.number}: ${pushRes.pullRequest.htmlUrl}` : '')
            },
            true,
            effectiveRoomToken
          );
        } catch (ghErr) {
          await appendRoomMessage(
            room,
            {
              senderType: 'system',
              senderName: 'GitHub Push',
              text: `⚠️ Aviso ao enviar push automático via extensão: ${ghErr.message || ghErr}`
            },
            false,
            effectiveRoomToken
          );
        }
      }

      if (extracted.shareText && agent.lastLiveProseText !== extracted.shareText) {
        agent.lastLiveProseText = extracted.shareText;
        await appendRoomMessage(
          room,
          {
            senderType: 'agent',
            senderName: agent.name,
            senderRole: agent.roleTitle,
            tabId,
            text: extracted.shareText
          },
          true,
          effectiveRoomToken
        );
        // Mirror turn-end share into the real-time HMAC-signed bus so peers mid-turn in bash see it immediately!
        pushRealtimeMessageToBin(room, {
          senderName: agent.name,
          senderRole: agent.roleTitle,
          tag: `ag${Number(agent.index || 0) + 1}`,
          text: extracted.shareText
        }).catch(() => {});
        wakeWaitingPeersInRoom(room, tabId);
      }

      if (extracted.isFinalReady) {
        room.finalDeliverable = AU_INTEGRATIONS.scrubSecrets(
          extracted.finalDeliverable || assistantText,
          effectiveRoomToken
        );
        room.finalBy = agent.name;
        persistCollabRooms();

        if (room.stopMode === 'smart_consensus') {
          const unspawnedSlots =
            Date.now() - (room.createdAt || 0) < 90000
              ? Math.max(0, (room.roles ? room.roles.length : 0) - (room.agents ? room.agents.length : 0))
              : 0;
          const allOpenSlots = (room.agents || []).filter((a) => !a.closed && a.screeningStatus !== 'refused_stopped');
          const pendingScreeningSlots = allOpenSlots.filter(
            (a) => a.admittedToTeam === false && Date.now() - (a.lastScreeningAt || room.createdAt || 0) < 90000
          );
          const distinctAgentSenders = new Set(
            (room.messages || []).filter((m) => m.senderType === 'agent' && m.tabId).map((m) => m.tabId)
          );
          const consensusMatrix =
            typeof AU_COLLAB.computeRoomConsensusMatrix === 'function'
              ? AU_COLLAB.computeRoomConsensusMatrix(room)
              : { hasBlocker: false, rejectedCount: 0, isQuorumMet: true, isMajorityApproved: true };
          const hasExplicitBlocker = Boolean(
            consensusMatrix && (consensusMatrix.hasBlocker || Number(consensusMatrix.rejectedCount || 0) > 0)
          );
          const requiredTeamQuorum =
            allOpenSlots.length <= 1 ? 1 : Math.min(allOpenSlots.length, Math.max(2, Math.ceil(allOpenSlots.length * 0.75)));
          const completedTeamAlignmentRound = allOpenSlots.length <= 1 || Number(agent.turnsCount || 1) >= 2;

          // ARENA-12 + Unified Team Quorum: Never close on Round 1 in multi-agent rooms before peers align & contribute!
          if (
            (!room.harness || AU_HARNESS.gate(room).ok) &&
            !hasExplicitBlocker &&
            completedTeamAlignmentRound &&
            unspawnedSlots === 0 &&
            pendingScreeningSlots.length === 0 &&
            (allOpenSlots.length <= 1 ||
              distinctAgentSenders.size >= requiredTeamQuorum ||
              Boolean(consensusMatrix && consensusMatrix.isMajorityApproved && distinctAgentSenders.size >= 2))
          ) {
            room.status = 'completed';
            await appendRoomMessage(
              room,
              {
                senderType: 'system',
                senderName: 'TempChat',
                text: `✅ Entrega Final Consolidada publicada por ${agent.name}! Todos os agentes concluíram em consenso verificável.`
              },
              true
            );
            persistCollabRooms(true);

            // Notify peer tabs in the room to stop gracefully and display completion banner
            for (const peer of allOpenSlots) {
              if (peer.tabId === tabId) continue;
              const pst = TAB_STATES.get(peer.tabId);
              if (pst) {
                pst.autoContinueEnabled = false;
                pst.status = 'idle';
                pst.stopReason = `Consenso atingido na Sala #${room.roomId}`;
                TAB_STATES.set(peer.tabId, pst);
              }
              sendTabMessageGroupSafe(
                peer.tabId,
                {
                  type: 'AU_EXECUTE_TAB_COMMAND',
                  command: 'collab_room_completed',
                  payload: {
                    roomId: room.roomId,
                    finalBy: agent.name
                  }
                },
                1800
              ).catch(() => {});
            }
            persistTabStates();
            refreshExtensionBadge();

            if (settings.desktopNotifications && chrome.notifications) {
              try {
                chrome.notifications.create('au_collab_done_' + room.roomId + '_' + Date.now(), {
                  type: 'basic',
                  iconUrl: chrome.runtime.getURL('icons/icon128.png'),
                  title: `🤝 Sala TempChat #${room.roomId} • Entrega Pronta!`,
                  message: `A equipe Multi-Agent consolidou a solução final (por ${agent.name}).`,
                  priority: 2
                });
              } catch (_) {}
            }

            await AU_STORAGE.appendSessionLog({
              tabTitle: `Sala TempChat #${room.roomId}`,
              url: (st && st.url) || 'https://arena.ai/agent',
              eventType: 'collab_completed',
              loopsCount: agent.turnsCount,
              details: `Entrega final consolidada por ${agent.name}`
            });

            return {
              ok: true,
              action: 'stop_completed',
              roomId: room.roomId,
              reason: `Entrega Final Consolidada por ${agent.name} na Sala #${room.roomId}`
            };
          }
        }
      }
    }
  }

  // Pull any live mid-turn messages (`auchat_*.json`), board updates, Vault requests & Git Radar events FIRST!
  await syncRoomFilebinBucket(room, 800);
  const integrationStatus = AU_COLLAB.computeRoomIntegrationStatus(room);

  // Gather unread messages from peers, human coordinator, GitHub Push, Radar Git, and Integration SLA events
  const unreadMessages = (room.messages || []).filter(
    (m) =>
      m.seq > Number(agent.lastSeenSeq || 0) &&
      m.tabId !== tabId &&
      (m.senderType !== 'system' ||
        m.senderName === 'GitHub Push' ||
        m.senderName === 'GitHub' ||
        m.senderName === 'Radar Git' ||
        m.senderName === 'Failover de Líder' ||
        m.senderName === 'Integração Final')
  );

  // Synchronized N-Agent Team Round Barrier:
  // Ensures fast agents DO NOT race ahead blind while teammates are still finishing Round 1 (Alignment & Role Division)
  // or finishing the same collaborative round — guaranteeing 100% peer visibility across any team size N!
  const nowTs = Date.now();
  const myRound = Math.max(1, Number(agent.turnsCount || 1));
  const hasUrgentCoordinatorMsg = unreadMessages.some(
    (m) => m.senderType === 'user' || m.senderType === 'coordinator'
  );
  const skipWaitForSynthesis = Boolean(agent.isSynthesizer && integrationStatus && integrationStatus.isIntegrationReady);

  if (!hasUrgentCoordinatorMsg && !skipWaitForSynthesis) {
    const unspawnedPeerSlots =
      nowTs - (room.createdAt || 0) < 95000
        ? Math.max(0, (room.roles ? room.roles.length : 0) - (room.agents ? room.agents.length : 0))
        : 0;
    const activePeers = (room.agents || []).filter((peer) => {
      if (!peer || peer.tabId === tabId || peer.closed) return false;
      if (peer.screeningStatus === 'refused_stopped') return false;
      if (PENDING_JOBS.has(peer.tabId)) return true;
      if (
        peer.admittedToTeam === false &&
        nowTs - (peer.lastScreeningAt || room.createdAt || 0) < 85000
      ) {
        return true;
      }
      const pst = TAB_STATES.get(peer.tabId);
      if (pst && (pst.status === 'token_stopped' || pst.status === 'needs_human')) return false;
      if (pst && pst.autoContinueEnabled && (pst.status === 'generating' || pst.status === 'queued' || pst.status === 'waiting_send')) {
        return true;
      }
      // Newly created tab still hydrating / submitting its Round 1 kickoff prompt
      if (Number(peer.turnsCount || 0) === 0 && nowTs - (room.createdAt || 0) < 75000) {
        return true;
      }
      return false;
    });

    const peersBehindInMyRound = activePeers.filter((peer) => Number(peer.turnsCount || 0) < myRound);
    const shouldHoldBarrier =
      unspawnedPeerSlots > 0 ||
      (myRound === 1 && peersBehindInMyRound.length > 0) ||
      (unreadMessages.length === 0 && activePeers.length > 0) ||
      (unreadMessages.length > 0 && peersBehindInMyRound.length > 0);

    if (shouldHoldBarrier) {
      if (!agent.waitingSince) {
        agent.waitingSince = nowTs;
        persistCollabRooms();
      }
      const waitedMs = nowTs - agent.waitingSince;
      const barrierTimeoutMs =
        myRound === 1
          ? 165000 // Round 1 Full-Team Huddle: wait up to 2m45s so ALL N agents see everyone's role claims & contracts!
          : unreadMessages.length === 0
            ? 135000 // Round 2+ with 0 unread: wait up to 2m15s for generating peers
            : 45000; // Round 2+ with partial unread: coalesce up to 45s while remaining peers finish the same round

      if (waitedMs < barrierTimeoutMs) {
        return {
          ok: true,
          action: 'wait_peers',
          roomId: room.roomId,
          waitingCount: Math.max(peersBehindInMyRound.length, activePeers.length) + unspawnedPeerSlots,
          waitedMs
        };
      }
    }
  }

  agent.waitingSince = 0;
  agent.lastSeenSeq = room.seq;
  persistCollabRooms();

  // SEC-01: Zero-Token invariant — token is ALWAYS '' in prompt configs!
  const runtimeGithubCfg =
    room.githubConfig && room.githubConfig.enabled
      ? Object.assign({}, room.githubConfig, {
          authMode: AU_DEFAULTS.normalizeGithubAuthMode(room.githubConfig.authMode),
          hasVaultCredential: Boolean(effectiveRoomToken),
          filebinId: room.filebinId || '',
          agentVaultCap: roomVaultCaps[slotKey] || '',
          token: ''
        })
      : null;

  let codebaseBriefing = '';
  if (room.githubConfig && room.githubConfig.fullName && typeof AU_STORAGE.getRepoMemory === 'function') {
    const mem = await AU_STORAGE.getRepoMemory(room.githubConfig.fullName).catch(() => null);
    if (mem && typeof AU_COLLAB.buildCodebaseBriefingBlock === 'function') {
      codebaseBriefing = AU_COLLAB.buildCodebaseBriefingBlock(mem);
    }
  }

  const nextPrompt = AU_COLLAB.buildNextCollabTurnPrompt({
    roomId: room.roomId,
    room,
    roomHmacKey: room.roomHmacKey || '',
    filebinId: room.filebinId || '',
    sharedBoard: room.sharedBoard,
    integrationStatus,
    codebaseBriefing,
    sessionTimerMinutes: settings.sessionMinTimerMinutes,
    agentKitEnabled: room.agentKitEnabled === true,
    agentKitCompatible: Boolean(agent.agentKit && agent.agentKit.compatible),
    compactChatCli: Boolean(agent.cliBootstrapped),
    harnessHint: room.harness ? AU_HARNESS.hint(room) + ` /tmp/au_harness bind ${agent.bindingEpoch || 1}` : '',
    totalTeamCount: Math.max(1, (room.agents || []).filter((a) => !a.closed).length || (room.roles || []).length || 2),
    agentRole: {
      index: agent.index,
      agentIndex: agent.index + 1,
      total: Math.max(1, (room.agents || []).length),
      roleTitle: agent.roleTitle,
      roleDesc: agent.roleDesc,
      shortTitle: agent.name,
      isSynthesizer: Boolean(agent.isSynthesizer),
      githubAccessLevel: agent.githubAccessLevel || 'auto_role'
    },
    unreadMessages,
    recentFiles: (room.sharedFiles || []).slice(-8),
    githubConfig: runtimeGithubCfg,
    stopMode: room.stopMode,
    roundNumber: Number(agent.turnsCount || 1) + 1
  });

  const finalSafePrompt =
    typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.scrubSecrets
      ? AU_CRED_BROKER.scrubSecrets(nextPrompt, effectiveRoomToken)
      : nextPrompt;

  return {
    ok: true,
    action: 'send_collab_prompt',
    roomId: room.roomId,
    bindingEpoch: agent.bindingEpoch || 1,
    prompt: finalSafePrompt,
    unreadCount: unreadMessages.length
  };
}

function hasAnyCaptchaWaitingTabGlobal() {
  for (const st of TAB_STATES.values()) {
    if (st && st.status === 'captcha_waiting') return true;
  }
  return false;
}

function scheduleSafeRerollNavigation(tabId, freshUrl) {
  rerollChain = rerollChain
    .then(async () => {
      const waitStart = Date.now();
      while (hasAnyCaptchaWaitingTabGlobal() && Date.now() - waitStart < 300000) {
        await sleep(700);
      }
      const gap = Date.now() - lastRerollNavAt;
      if (gap < 1800) {
        await sleep(1800 - gap);
      }
      lastRerollNavAt = Date.now();
      try {
        await withCollapsedGroupAwake(tabId, async () => {
          await chrome.tabs.update(tabId, { url: freshUrl || 'https://arena.ai/agent' });
          await sleep(300);
        });
      } catch (_) {
        PENDING_JOBS.delete(tabId);
      }
    })
    .catch(() => {});
  return rerollChain;
}

async function handleThinkingModelRefused(tabId, payload = {}) {
  await ensureVolatileWorkerStateLoaded();
  await ensureCollabRoomsLoaded();
  const settings = await AU_STORAGE.getSettings();
  const indicator = String(payload.indicator || 'Thinking...').trim();
  const st = TAB_STATES.get(tabId) || { tabId };
  const roomId = String(payload.collabRoomId || st.collabRoomId || '').trim();
  const room = roomId ? COLLAB_ROOMS.get(roomId) : null;
  const agent = room ? (room.agents || []).find((a) => a.tabId === tabId) : null;

  const prevCount = agent ? Number(agent.refusedCount || 0) : Number(st.thinkingRefusedCount || 0);
  const nextCount = prevCount + 1;
  st.thinkingRefusedCount = nextCount;

  // Clear cached conversation state for the refused /agent/<uuid> session so it never resurrects
  let detectedConvId = String(payload.convId || '').trim();
  if (st.url) {
    const oldCk = extractConvKey(st.url);
    if (!detectedConvId && oldCk) {
      detectedConvId = oldCk.replace(/^\//, '');
    }
    if (oldCk && cachedConvStates[oldCk]) {
      delete cachedConvStates[oldCk];
    }
  }
  if (detectedConvId && !payload.archived) {
    if (PENDING_ARCHIVE_IDS.size > 30) {
      PENDING_ARCHIVE_IDS.clear();
    }
    PENDING_ARCHIVE_IDS.add(detectedConvId);
    persistVolatileWorkerState();
  }

  await AU_STORAGE.updateMetrics((m) => {
    m.totalThinkingModelsRefused = (m.totalThinkingModelsRefused || 0) + 1;
    return m;
  });

  const maxRetries = Number(settings.refuseThinkingMaxRetries !== undefined ? settings.refuseThinkingMaxRetries : 15);
  const autoReroll = settings.refuseThinkingAutoReroll !== false;
  const promptForReroll = String(payload.initialPrompt || SLOT_INITIAL_PROMPTS.get(tabId) || '').trim();
  if (promptForReroll) {
    SLOT_INITIAL_PROMPTS.set(tabId, promptForReroll);
    persistVolatileWorkerState();
  }

  const exceededRetries = maxRetries > 0 && nextCount > maxRetries;
  const canReroll = autoReroll && !exceededRetries && Boolean(promptForReroll);

  if (!canReroll) {
    st.autoContinueEnabled = false;
    st.status = 'thinking_refused';
    st.stopReason = exceededRetries
      ? `Limite de ${maxRetries} tentativas atingido recusando modelos "${indicator}"`
      : `Modelo com "${indicator}" parado e recusado`;
    TAB_STATES.set(tabId, st);
    persistTabStates();

    if (room && agent) {
      agent.admittedToTeam = false;
      agent.screeningStatus = 'refused_stopped';
      agent.refusedCount = nextCount;
      await appendRoomMessage(
        room,
        {
          senderType: 'system',
          senderName: 'Time Anti-Thinking',
          text: `🚫 ${agent.name}: modelo com "${indicator}" foi parado e recusado do Time${exceededRetries ? ` (limite de ${maxRetries} tentativas atingido)` : ''}.`
        },
        false,
        getActiveVaultToken(room.roomId, settings)
      );
      ensureHealthySynthesizerLeader(room);
      persistCollabRooms();
    }

    await AU_STORAGE.appendSessionLog({
      tabTitle: st.title || 'Arena Agent',
      url: st.url || 'https://arena.ai/agent',
      eventType: 'thinking_refused',
      loopsCount: Number(st.loopsCount || 0),
      details: `Parado/Recusado sem re-roll (${indicator} • tentativa #${nextCount})`
    });

    await refreshExtensionBadge();
    return {
      ok: true,
      action: 'stopped_only',
      attempt: nextCount,
      reason: st.stopReason
    };
  }

  // Auto Re-Roll: keep slot OUT of active Team while drawing a brand-new model on https://arena.ai/agent!
  if (room && agent) {
    agent.admittedToTeam = false;
    agent.screeningStatus = 'rerolling';
    agent.refusedCount = nextCount;
    agent.lastScreeningAt = Date.now();
    agent.lastTurnHash = '';
    agent.cliBootstrapped = false;
    agent.agentKit = null;
    room.thinkingRefusalsCount = Number(room.thinkingRefusalsCount || 0) + 1;
    await appendRoomMessage(
      room,
      {
        senderType: 'system',
        senderName: 'Time Anti-Thinking',
        text: `🚫 ${agent.name}: modelo mostrou "${indicator}" — parado${payload.archived ? ', arquivado (··· → Archive)' : ''} e recusado (#${nextCount}). Sorteando novo modelo sem Thinking para o Time...`
      },
      false,
      getActiveVaultToken(room.roomId, settings)
    );
    persistCollabRooms();
  }

  const rerollGhActive = payload.githubActive !== undefined ? Boolean(payload.githubActive) : Boolean(st.githubActive);
  const rerollGhRepo = payload.githubRepo || st.githubRepo || '';
  const rerollGhBase = payload.githubBaseBranch || st.githubBaseBranch || '';
  const rerollGhBranch = payload.githubBranch || st.githubBranch || '';

  const rerollJob = {
    jobId: `reroll_${tabId}_${nextCount}_${Date.now()}`,
    initialPrompt: promptForReroll,
    autoEnableLoop: payload.autoContinueEnabled !== undefined ? Boolean(payload.autoContinueEnabled) : true,
    strategy: payload.strategy || st.strategy || settings.autoContinueStrategy || 'hybrid',
    fixedPrompt: payload.fixedPrompt || st.customFixedPrompt || settings.fixedContinuePrompt,
    queue: Array.isArray(payload.queue) ? payload.queue.slice() : [],
    collabRoomId: room ? room.roomId : roomId,
    collabAgentName: (agent && agent.name) || payload.collabAgentName || st.collabAgentName || '',
    githubActive: rerollGhActive,
    githubRepo: rerollGhRepo,
    githubBaseBranch: rerollGhBase,
    githubBranch: rerollGhBranch,
    refuseThinkingModels: true,
    rerollAttempt: nextCount,
    createdAt: Date.now(),
    lastPushAt: 0
  };

  PENDING_JOBS.set(tabId, rerollJob);
  persistVolatileWorkerState();

  st.url = 'https://arena.ai/agent';
  st.status = 'queued';
  st.loopsCount = 0;
  st.stopReason = '';
  st.autoContinueEnabled = rerollJob.autoEnableLoop;
  st.githubActive = rerollGhActive;
  st.githubRepo = rerollGhRepo;
  st.githubBaseBranch = rerollGhBase;
  st.githubBranch = rerollGhBranch;
  TAB_STATES.set(tabId, st);
  persistTabStates();

  await AU_STORAGE.appendSessionLog({
    tabTitle: (agent && `${agent.name} • Sala #${room.roomId}`) || st.title || 'Arena Agent',
    url: 'https://arena.ai/agent',
    eventType: 'thinking_refused',
    loopsCount: nextCount,
    details: `Modelo com "${indicator}" recusado (tentativa #${nextCount}) → sorteando novo chat Agent`
  });

  ensureAntiThrottleHeartbeat();
  await refreshExtensionBadge();
  scheduleSafeRerollNavigation(tabId, 'https://arena.ai/agent');

  return {
    ok: true,
    action: 'rerolling',
    attempt: nextCount
  };
}

async function createCollabRoomFromOpenTabs(opts = {}) {
  await syncOpenArenaTabs();
  const settings = await AU_STORAGE.getSettings();
  const refuseThinking =
    opts.refuseThinkingModels !== undefined
      ? Boolean(opts.refuseThinkingModels)
      : settings.refuseThinkingModels !== false;

  const candidateTabs = Array.from(TAB_STATES.values()).filter((t) => {
    if (Array.isArray(opts.tabIds) && opts.tabIds.length > 0) {
      return opts.tabIds.includes(t.tabId);
    }
    return t.status !== 'token_stopped' && t.status !== 'thinking_refused';
  });

  if (candidateTabs.length === 0) {
    throw new Error('Nenhuma aba do Arena.ai disponível para unir na Sala TempChat.');
  }

  // Probe candidate tabs so any open tab ALREADY displaying Thinking... / Thought for... is stopped & refused from joining the Team!
  const targetTabs = [];
  const tabQualificationMap = new Map();
  let refusedOpenCount = 0;

  for (const t of candidateTabs) {
    if (!refuseThinking) {
      targetTabs.push(t);
      tabQualificationMap.set(t.tabId, { admitted: true, status: 'admitted' });
      continue;
    }

    const probe = await sendTabMessageGroupSafe(
      t.tabId,
      { type: 'AU_CHECK_TAB_HAS_THINKING', stopOnDetect: true },
      6800
    );

    if (probe && probe.hasThinking) {
      refusedOpenCount += 1;
      t.autoContinueEnabled = false;
      t.status = 'token_stopped';
      t.stopReason = `Recusado do Time (${probe.indicator || 'Thinking'})`;
      TAB_STATES.set(t.tabId, t);
      await AU_STORAGE.updateMetrics((m) => {
        m.totalThinkingModelsRefused = (m.totalThinkingModelsRefused || 0) + 1;
        return m;
      });
      continue;
    }

    const alreadyCleanAssistantReply = Boolean(probe && probe.hasCleanAssistantReply && !probe.isGenerating);
    targetTabs.push(t);
    tabQualificationMap.set(t.tabId, {
      admitted: alreadyCleanAssistantReply,
      status: alreadyCleanAssistantReply ? 'admitted' : 'screening'
    });
  }

  if (targetTabs.length === 0) {
    persistTabStates();
    throw new Error(
      `Todas as ${refusedOpenCount} aba(s) abertas mostraram "Thinking..." / "Thought for..." e foram recusadas pelo Modo Sem-Thinking!`
    );
  }

  const profile = opts.profile || settings.collabDefaultProfile || 'specialists';
  const stopMode = opts.stopMode || settings.collabDefaultStopMode || 'smart_consensus';
  const mirrorExternal =
    opts.mirrorExternal !== undefined ? Boolean(opts.mirrorExternal) : Boolean(settings.collabMirrorExternalTempChat);

  const autoDetectedSpecInUnite =
    !opts.githubEnabled && settings.githubAutoDetectInPrompt !== false && AU_INTEGRATIONS.extractGithubRepoFromText
      ? AU_INTEGRATIONS.extractGithubRepoFromText(opts.baseTask || '')
      : null;

  const room = await createCollabRoom({
    baseTask: opts.baseTask || 'Colaboração em abas abertas',
    profile,
    stopMode,
    mirrorExternal,
    refuseThinkingModels: refuseThinking,
    joinExternalCode: opts.joinExternalCode || '',
    agentCount: targetTabs.length,
    githubEnabled: Boolean(opts.githubEnabled || autoDetectedSpecInUnite),
    githubRepo:
      opts.githubRepo ||
      (autoDetectedSpecInUnite ? autoDetectedSpecInUnite.webUrl : '') ||
      settings.githubDefaultRepo ||
      '',
    githubToken: opts.githubToken || '',
    githubBaseBranch:
      opts.githubBaseBranch ||
      (autoDetectedSpecInUnite && autoDetectedSpecInUnite.branchFromUrl) ||
      settings.githubBaseBranch ||
      'main',
    githubAuthMode: opts.githubAuthMode || settings.githubAuthMode || 'vault_broker_zero_token',
    githubBranchMode: opts.githubBranchMode || settings.githubBranchMode || 'branch_per_agent_pr',
    githubSharedBranch: opts.githubSharedBranch || '',
    githubDefaultAgentAccessMode: opts.githubDefaultAgentAccessMode || settings.githubDefaultAgentAccessMode || 'auto_role',
    integrationTimeoutMinutes:
      opts.collabIntegrationTimeoutMinutes ||
      opts.integrationTimeoutMinutes ||
      settings.collabIntegrationTimeoutMinutes ||
      25
  });

  const latestSettingsForUnite = await AU_STORAGE.getSettings();
  const effectiveUniteToken = getActiveVaultToken(room.roomId, latestSettingsForUnite);
  const uniteVaultCaps = ensureRoomVaultCaps(room);
  let uniteRuntimeGithubCfg = null;
  if (room.githubConfig && room.githubConfig.enabled) {
    const snapUrl = await stageRepoSnapshotForProxyIfNeeded(
      room.githubConfig,
      effectiveUniteToken,
      room.filebinId
    );
    if (snapUrl) {
      room.githubConfig.repoSnapshotUrl = snapUrl;
    }
    uniteRuntimeGithubCfg = Object.assign({}, room.githubConfig, {
      authMode: AU_DEFAULTS.normalizeGithubAuthMode(room.githubConfig.authMode),
      autoCreatePR: latestSettingsForUnite.githubAutoCreatePR !== false,
      hasVaultCredential: Boolean(effectiveUniteToken),
      filebinId: room.filebinId || '',
      token: ''
    });
  }

  if (refusedOpenCount > 0) {
    await appendRoomMessage(
      room,
      {
        senderType: 'system',
        senderName: 'Time Anti-Thinking',
        text: `🚫 ${refusedOpenCount} aba(s) com "Thinking..." / "Thought for..." foram paradas e recusadas na criação do Time.`
      },
      false
    );
  }

  if (refusedOpenCount > 0) {
    room.thinkingRefusalsCount = Number(room.thinkingRefusalsCount || 0) + refusedOpenCount;
  }

  for (let i = 0; i < targetTabs.length; i++) {
    const t = targetTabs[i];
    const role = room.roles[i];
    const slotKey = `ag${i + 1}`;
    const bindingEpoch = nextTabBindingEpoch(t.tabId);
    const qual = tabQualificationMap.get(t.tabId) || { admitted: !refuseThinking, status: refuseThinking ? 'screening' : 'admitted' };
    room.agents.push({
      tabId: t.tabId,
      bindingEpoch,
      index: i,
      name: role.shortTitle,
      roleTitle: role.roleTitle,
      roleDesc: role.roleDesc,
      isSynthesizer: role.isSynthesizer,
      githubAccessLevel: role.githubAccessLevel || 'auto_role',
      admittedToTeam: qual.admitted,
      screeningStatus: qual.status,
      refusedCount: 0,
      lastScreeningAt: Date.now(),
      lastSeenSeq: room.seq,
      lastTurnHash: '',
      waitingSince: 0,
      turnsCount: 0,
      closed: false
    });

    const perAgentUniteGh = uniteRuntimeGithubCfg
      ? Object.assign({}, uniteRuntimeGithubCfg, {
          agentVaultCap: uniteVaultCaps[slotKey] || '',
          token: ''
        })
      : null;
    const assignedUniteBranch = perAgentUniteGh
      ? AU_COLLAB.computeAgentBranchName(room.roomId, role, perAgentUniteGh)
      : '';
    t.collabRoomId = room.roomId;
    t.collabAgentName = role.shortTitle;
    t.bindingEpoch = bindingEpoch;
    t.autoContinueEnabled = true;
    if (perAgentUniteGh) {
      t.githubActive = true;
      t.githubRepo = perAgentUniteGh.repo || '';
      t.githubBaseBranch = perAgentUniteGh.baseBranch || 'main';
      t.githubBranch = assignedUniteBranch;
    }
    TAB_STATES.set(t.tabId, t);

    const uniteKickoffPrompt = AU_COLLAB.buildInitialAgentPrompt({
      uniteOpenTabs: true,
      agentKitEnabled: room.agentKitEnabled === true,
      bindingEpoch: bindingEpoch,
      harnessEnabled: latestSettingsForUnite.harnessEnabled !== false,
      sessionTimerMinutes: latestSettingsForUnite.sessionMinTimerMinutes,
      roomId: room.roomId,
      externalCode: room.externalCode || '',
      roomHmacKey: room.roomHmacKey || '',
      filebinId: room.filebinId,
      profile: room.profile || 'specialists',
      stopMode: room.stopMode || 'smart_consensus',
      agentRole: role,
      teamRoles: room.roles,
      sharedBoard: room.sharedBoard,
      integrationStatus: AU_COLLAB.computeRoomIntegrationStatus(room),
      basePrompt:
        opts.baseTask ||
        'Alinhem-se como UM ÚNICO TIME UNIDO no TempChat, dividam responsabilidades e arquivos sem sobreposição e colaborem para entregar uma solução unificada.',
      githubConfig: perAgentUniteGh,
      tempFileConfig: { enabled: Boolean(room.filebinId), filebinId: room.filebinId }
    });

    await sendTabMessageGroupSafe(
      t.tabId,
      {
        type: 'AU_EXECUTE_TAB_COMMAND',
        command: 'join_collab_room',
        payload: {
          roomId: room.roomId,
          bindingEpoch,
          agentName: role.shortTitle,
          roleTitle: role.roleTitle,
          refuseThinkingModels: refuseThinking,
          admittedToTeam: qual.admitted,
          githubActive: Boolean(uniteRuntimeGithubCfg),
          githubRepo: uniteRuntimeGithubCfg ? uniteRuntimeGithubCfg.repo : '',
          githubBaseBranch: uniteRuntimeGithubCfg ? uniteRuntimeGithubCfg.baseBranch : '',
          githubBranch: assignedUniteBranch,
          kickoffMessage: opts.baseTask || '',
          kickoffPrompt: uniteKickoffPrompt
        }
      },
      2200
    );
  }

  if (settings.launcherAutoGroupTabs && targetTabs.length > 1) {
    await groupTabsSafely(
      targetTabs.map((t) => t.tabId),
      `🤝 TempChat #${room.roomId}`,
      'cyan'
    );
  }

  persistCollabRooms(true);
  persistTabStates(true);
  ensureAntiThrottleHeartbeat();
  await refreshExtensionBadge();

  return serializeRoomForClient(room);
}

function protectTabFromFreeze(tabId, protect = true) {
  if (!tabId || !chrome.tabs || typeof chrome.tabs.update !== 'function') return;
  if (PROTECTED_TABS.get(tabId) === protect) return;
  PROTECTED_TABS.set(tabId, protect);
  try {
    chrome.tabs.update(tabId, { autoDiscardable: !protect }).catch(() => {
      PROTECTED_TABS.delete(tabId);
    });
  } catch (_) {
    PROTECTED_TABS.delete(tabId);
  }
}

// Round-Robin Memory-Saver Reviver:
// When the browser displays "High Memory Usage" / "Memory Saver" and discards background tabs (tab.discarded === true),
// we gently reload ONE discarded Autopilot tab every 18s so RAM stays low while every Agent checks "Continuar trabalhando" & continues!
async function reviveDiscardedAutopilotTabsIfNeeded(now) {
  if (now - lastDiscardReviveAt < 18000) return;
  if (!chrome.tabs || typeof chrome.tabs.query !== 'function' || typeof chrome.tabs.reload !== 'function') return;

  try {
    const tabs = await chrome.tabs.query({});
    const discardedActive = tabs.filter((t) => {
      if (!t.discarded && t.status !== 'unloaded') return false;
      const st = TAB_STATES.get(t.id);
      if (st && st.autoContinueEnabled && st.status !== 'token_stopped') return true;
      const convKey = extractConvKey(t.url || t.pendingUrl || '');
      const convSaved = convKey ? cachedConvStates[convKey] : null;
      return Boolean(convSaved && convSaved.autoContinueEnabled && convSaved.status !== 'token_stopped');
    });

    if (!discardedActive.length) return;
    lastDiscardReviveAt = now;
    const pick = discardedActive[discardReviveCursor % discardedActive.length];
    discardReviveCursor = (discardReviveCursor + 1) % 10000;
    await chrome.tabs.reload(pick.id);
  } catch (_) {}
}

async function ensureOffscreenKeepAlive(shouldExist) {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') return;
  if (offscreenSyncInFlight) return;
  offscreenSyncInFlight = true;
  try {
    let exists = false;
    if (typeof chrome.offscreen.hasDocument === 'function') {
      exists = await chrome.offscreen.hasDocument();
    }
    if (shouldExist && !exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['WORKERS', 'BLOBS'],
        justification: 'Keep multi-agent orchestration timers active during Windows Lock Screen and Virtual Desktops'
      });
    } else if (!shouldExist && exists && typeof chrome.offscreen.closeDocument === 'function') {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {
  } finally {
    offscreenSyncInFlight = false;
  }
}

function ensureAntiThrottleHeartbeat() {
  let anyActive = false;
  for (const st of TAB_STATES.values()) {
    if (st.autoContinueEnabled) {
      anyActive = true;
      protectTabFromFreeze(st.tabId, true);
    }
  }
  if (PENDING_JOBS.size > 0) anyActive = true;
  for (const r of COLLAB_ROOMS.values()) {
    if (r.status === 'active') {
      anyActive = true;
      break;
    }
  }

  ensureOffscreenKeepAlive(anyActive);

  if (anyActive && !heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      broadcastTickToActiveTabs();
    }, 2000);
  } else if (!anyActive && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

const CONTENT_ISOLATED_SCRIPTS = [
  'shared/i18n.js',
  'shared/cred-broker.js',
  'shared/diff-engine.js',
  'shared/arena-adapter.js',
  'shared/scheduler.js',
  'shared/plugin-runtime.js',
  'shared/defaults.js',
  'shared/storage.js',
  'shared/integrations.js',
  'shared/collab-engine.js',
  'content/themes.js',
  'content/content.js'
];

async function broadcastTickToActiveTabs() {
  const now = Date.now();
  if (now - lastBroadcastTickAt < 1100) return;
  lastBroadcastTickAt = now;

  if (TAB_STATES.size === 0) {
    await syncOpenArenaTabs();
  }

  // Gently revive one Memory-Saver-discarded Autopilot tab at a time if High RAM discarded any!
  await reviveDiscardedAutopilotTabsIfNeeded(now);

  // Sync real-time mid-turn Agent-to-Agent chat messages (auchat_*.json) across active TempChat rooms!
  syncAllActiveCollabRoomsRealtime().catch(() => {});

  const settings = await AU_STORAGE.getSettings();

  // Retry pushing any pending launch job that hasn't confirmed start yet (waking collapsed Tab Groups if needed!)
  for (const [tabId, job] of PENDING_JOBS.entries()) {
    if (now - (job.createdAt || 0) > 120000) {
      PENDING_JOBS.delete(tabId);
      continue;
    }
    if (now - (job.lastPushAt || 0) >= 2200) {
      job.lastPushAt = now;
      const sentVal = await sendTabMessageGroupSafe(tabId, { type: 'AU_RUN_PENDING_JOB', job }, 1500);
      if (!sentVal && chrome.scripting && now - (job.createdAt || 0) >= 3500) {
        withCollapsedGroupAwake(tabId, async () => {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            files: ['content/page-bridge.js']
          }).catch(() => {});
          await chrome.scripting.executeScript({
            target: { tabId },
            files: CONTENT_ISOLATED_SCRIPTS
          }).catch(() => {});
        }).catch(() => {});
      }
    }
  }

  if (!settings.antiThrottleEnabled) return;

  for (const [tabId, st] of TAB_STATES.entries()) {
    if (!st.autoContinueEnabled && !PENDING_JOBS.has(tabId)) continue;
    protectTabFromFreeze(tabId, true);

    if (PENDING_JOBS.has(tabId)) {
      const pJob = PENDING_JOBS.get(tabId);
      if (pJob && now - (pJob.lastPushAt || 0) >= 1600) {
        pJob.lastPushAt = now;
        sendTabMessageGroupSafe(tabId, { type: 'AU_RUN_PENDING_JOB', job: pJob }, 1500).catch(() => {});
      }
    }

    // Only attempt executeScript recovery if the tab has NO active keep-alive port AND hasn't responded for >45s!
    // Never re-inject 400KB of scripts every few seconds into healthy streaming tabs!
    if (
      !ACTIVE_PORTS.has(tabId) &&
      st.autoContinueEnabled &&
      st.status !== 'token_stopped' &&
      now - (st.lastActivityAt || 0) > 45000 &&
      now - (st.lastWakeAttemptAt || 0) > 45000
    ) {
      st.lastWakeAttemptAt = now;
      withCollapsedGroupAwake(tabId, async () => {
        const pingOk = await sendTabMessageGroupSafe(tabId, { type: 'AU_HEARTBEAT_TICK', now }, 1200);
        if (!pingOk && chrome.tabs && chrome.scripting) {
          const t = await chrome.tabs.get(tabId).catch(() => null);
          if (t && !t.discarded && t.status !== 'unloaded' && (isArenaUrl(t.url || '') || !t.url)) {
            await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              files: ['content/page-bridge.js']
            }).catch(() => {});
            await chrome.scripting.executeScript({
              target: { tabId },
              files: CONTENT_ISOLATED_SCRIPTS
            }).catch(() => {});
          }
        }
      }).catch(() => {});
    }

    const port = ACTIVE_PORTS.get(tabId);
    if (port) {
      try {
        port.postMessage({ type: 'AU_HEARTBEAT_TICK', now });
        continue;
      } catch (_) {
        ACTIVE_PORTS.delete(tabId);
      }
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'AU_HEARTBEAT_TICK', now });
    } catch (_) {}
  }

  // Batch active runtime seconds in RAM and flush to chrome.storage.local only once every 30s (prevents 1.8s LevelDB + storage.onChanged churn!)
  let runningCount = 0;
  for (const st of TAB_STATES.values()) {
    if (st.autoContinueEnabled && st.status !== 'token_stopped') runningCount += 1;
  }
  if (runningCount > 0) {
    unsavedActiveRuntimeSec += 2;
    if (unsavedActiveRuntimeSec >= 30) {
      const toFlush = unsavedActiveRuntimeSec;
      unsavedActiveRuntimeSec = 0;
      AU_STORAGE.updateMetrics((m) => {
        m.totalActiveRuntimeSec = (m.totalActiveRuntimeSec || 0) + toFlush;
        return m;
      }).catch(() => {});
    }
  }
}

let unsavedActiveRuntimeSec = 0;

async function syncOpenArenaTabs() {
  try {
    await ensureCollabRoomsLoaded();
    const persisted = await loadPersistedTabStates();
    const tabs = await chrome.tabs.query({});
    const openBrowserTabIds = new Set(tabs.map((t) => t.id));
    const validIds = new Set();

    const roomAgentTabIds = new Set();
    for (const r of COLLAB_ROOMS.values()) {
      for (const ag of r.agents || []) {
        if (ag && ag.tabId && !ag.closed) roomAgentTabIds.add(ag.tabId);
      }
    }

    for (const t of tabs) {
      const effectiveUrl = t.url || t.pendingUrl || '';
      const hasPendingJob = PENDING_JOBS.has(t.id);
      const isKnownArenaTab =
        TAB_STATES.has(t.id) ||
        Boolean(persisted.byTab[t.id]) ||
        roomAgentTabIds.has(t.id);
      const navigatedAwayToExternalHttp =
        /^https?:\/\//i.test(effectiveUrl) && !isArenaUrl(effectiveUrl);

      // Keep grouped / collapsed / sleeping / unloaded tabs whose URL is temporarily blank or wrapped!
      if (isArenaUrl(effectiveUrl) || hasPendingJob || (isKnownArenaTab && !navigatedAwayToExternalHttp)) {
        validIds.add(t.id);
        const convKey = extractConvKey(effectiveUrl);
        const saved = persisted.byTab[t.id] || (convKey ? persisted.byConv[convKey] : null) || {};
        // ARENA-18: Only restore collabRoomId for t.id if COLLAB_ROOMS explicitly lists t.id as an open member!
        let verifiedRoomId = '';
        let verifiedAgentName = '';
        let verifiedEpoch = 0;
        if (saved.collabRoomId && COLLAB_ROOMS.has(saved.collabRoomId)) {
          const rCheck = COLLAB_ROOMS.get(saved.collabRoomId);
          const agCheck = (rCheck.agents || []).find((a) => a && a.tabId === t.id && !a.closed);
          if (agCheck && rCheck.status !== 'closed') {
            verifiedRoomId = rCheck.roomId;
            verifiedAgentName = agCheck.name || saved.collabAgentName || '';
            verifiedEpoch = agCheck.bindingEpoch || 1;
          }
        }
        const existing = TAB_STATES.get(t.id) || {
          tabId: t.id,
          windowId: t.windowId,
          groupId: typeof t.groupId === 'number' ? t.groupId : -1,
          url: isArenaUrl(effectiveUrl) ? effectiveUrl : (saved.url || 'https://arena.ai/agent'),
          title: t.title || 'Arena.ai',
          mode: detectModeFromUrl(isArenaUrl(effectiveUrl) ? effectiveUrl : 'https://arena.ai/agent'),
          autoContinueEnabled: Boolean(saved.autoContinueEnabled),
          strategy: saved.strategy || 'hybrid',
          customFixedPrompt: saved.customFixedPrompt || '',
          promptQueue: Array.isArray(saved.promptQueue) ? saved.promptQueue.slice() : [],
          status: hasPendingJob ? 'queued' : (saved.status || 'idle'),
          loopsCount: Number(saved.loopsCount || 0),
          queueLength: Number(saved.queueLength || 0),
          estimatedTokens: Number(saved.estimatedTokens || 0),
          lastActivityAt: Date.now(),
          stopReason: saved.stopReason || '',
          collabRoomId: verifiedRoomId,
          collabAgentName: verifiedAgentName,
          bindingEpoch: verifiedEpoch,
          githubActive: Boolean(saved.githubActive),
          githubRepo: saved.githubRepo || '',
          githubBaseBranch: saved.githubBaseBranch || '',
          githubBranch: saved.githubBranch || ''
        };
        existing.windowId = t.windowId;
        existing.groupId = typeof t.groupId === 'number' ? t.groupId : -1;
        if (isArenaUrl(effectiveUrl)) existing.url = effectiveUrl;
        if (t.title) existing.title = t.title;
        if ((!existing.mode || existing.mode === 'chat') && isArenaUrl(effectiveUrl)) {
          existing.mode = detectModeFromUrl(effectiveUrl);
        }
        TAB_STATES.set(t.id, existing);
      }
    }

    // Never drop tabs hidden in Opera Workspaces / Vivaldi Stacks / Collapsed Groups unless chrome.tabs.get confirms closure!
    for (const id of Array.from(TAB_STATES.keys())) {
      if (!validIds.has(id)) {
        let stillExists = false;
        if (chrome.tabs && typeof chrome.tabs.get === 'function') {
          const checkTab = await chrome.tabs.get(id).catch(() => null);
          if (checkTab) {
            const u = checkTab.url || checkTab.pendingUrl || '';
            if (!/^https?:\/\//i.test(u) || isArenaUrl(u)) {
              stillExists = true;
              validIds.add(id);
              openBrowserTabIds.add(id);
            }
          }
        }
        if (!stillExists) {
          TAB_STATES.delete(id);
          ACTIVE_PORTS.delete(id);
        }
      }
    }
    for (const id of Array.from(PENDING_JOBS.keys())) {
      if (!openBrowserTabIds.has(id)) {
        const checkTab = chrome.tabs && chrome.tabs.get ? await chrome.tabs.get(id).catch(() => null) : null;
        if (!checkTab) {
          PENDING_JOBS.delete(id);
        }
      }
    }
    persistTabStates();
    await refreshExtensionBadge();
    ensureAntiThrottleHeartbeat();
  } catch (_) {}
}

async function sendWebhookNotification(webhookUrl, payload) {
  if (!webhookUrl || !webhookUrl.trim()) return { ok: false, reason: 'URL vazia' };
  const url = webhookUrl.trim();
  const isDiscord = /discord(app)?\.com\/api\/webhooks/i.test(url);

  const body = isDiscord
    ? {
        username: 'Arena Ultra • Autopilot',
        embeds: [
          {
            title: payload.title || 'Alerta Arena Ultra',
            description: payload.message || '',
            color: payload.color || 0xef4444,
            fields: [
              { name: 'Aba / Sessão', value: String(payload.tabTitle || 'Arena.ai').slice(0, 200), inline: true },
              { name: 'Loops Executados', value: String(payload.loopsCount || 0), inline: true },
              { name: 'Status', value: String(payload.statusLabel || 'Sem Tokens / Limite'), inline: true }
            ],
            footer: { text: 'Arena Ultra Browser Extension' },
            timestamp: new Date().toISOString()
          }
        ]
      }
    : {
        text: `*${payload.title || 'Arena Ultra'}*\n${payload.message || ''}\nSessão: ${payload.tabTitle || 'Arena.ai'} | Loops: ${payload.loopsCount || 0}`,
        event: payload
      };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { ok: resp.ok, status: resp.status };
}

async function handleTokenLimitStop(tabId, report) {
  const settings = await AU_STORAGE.getSettings();
  const st = TAB_STATES.get(tabId) || { tabId };
  st.autoContinueEnabled = false;
  st.status = 'token_stopped';
  st.stopReason = report.reason || 'Limite de tokens/créditos detectado';
  st.lastActivityAt = Date.now();
  TAB_STATES.set(tabId, st);

  await refreshExtensionBadge();
  ensureAntiThrottleHeartbeat();

  await AU_STORAGE.updateMetrics((m) => {
    m.totalTokenLimitStops = (m.totalTokenLimitStops || 0) + 1;
    return m;
  });

  await AU_STORAGE.appendSessionLog({
    tabTitle: st.title || report.tabTitle || 'Arena.ai',
    url: st.url || report.url || '',
    eventType: 'token_stop',
    loopsCount: st.loopsCount || report.loopsCount || 0,
    details: st.stopReason
  });

  if (settings.desktopNotifications && chrome.notifications) {
    try {
      chrome.notifications.create('au_stop_' + tabId + '_' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Arena Ultra • Limite de Tokens Atingido',
        message: `A sessão "${(st.title || 'Arena Agent').slice(0, 55)}" parou após ${st.loopsCount || 0} loops (${st.stopReason}).`,
        priority: 2
      });
    } catch (_) {}
  }

  const activeWebhook = (SESSION_WEBHOOK_URL && SESSION_WEBHOOK_URL.trim()) || (settings.webhookUrl && settings.webhookUrl.trim()) || '';
  if (activeWebhook) {
    sendWebhookNotification(activeWebhook, {
      title: '⚠️ Sessão Pausada — Limite de Tokens Atingido',
      message: `O Auto-Continue parou imediatamente na aba porque o limite de tokens/uso foi atingido.\n**Motivo detectado:** ${st.stopReason}`,
      tabTitle: st.title || report.tabTitle || 'Arena.ai',
      loopsCount: st.loopsCount || report.loopsCount || 0,
      statusLabel: 'Sem Tokens / Parado',
      color: 0xef4444
    }).catch(() => {});
  }
}

async function groupTabsSafely(tabIds, title, color) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return null;
  if (!chrome.tabs || typeof chrome.tabs.group !== 'function') return null;
  try {
    let preserveCollapsed = false;
    if (chrome.tabs.get && chrome.tabGroups && typeof chrome.tabGroups.get === 'function') {
      const firstTab = await chrome.tabs.get(tabIds[0]).catch(() => null);
      if (firstTab && typeof firstTab.groupId === 'number' && firstTab.groupId >= 0) {
        const prevGrp = await chrome.tabGroups.get(firstTab.groupId).catch(() => null);
        if (prevGrp && prevGrp.collapsed) preserveCollapsed = true;
      }
    }
    const groupId = await chrome.tabs.group({ tabIds });
    if (chrome.tabGroups && typeof chrome.tabGroups.update === 'function') {
      await chrome.tabGroups.update(groupId, {
        title: title || 'Arena Ultra • Agents',
        color: color || 'green',
        collapsed: preserveCollapsed
      });
    }
    return groupId;
  } catch (_) {
    return null;
  }
}

async function launchMultiAgentBatch(config) {
  const settings = await AU_STORAGE.getSettings();
  const targetUrl = (config.targetUrl || settings.launcherDefaultUrl || 'https://arena.ai/agent').trim();
  const staggerMs = Math.max(300, Number(config.staggerMs ?? settings.launcherStaggerMs ?? 1400));
  const autoEnableLoop = config.autoEnableLoop !== undefined ? Boolean(config.autoEnableLoop) : Boolean(settings.launcherAutoEnableLoop);
  const autoGroup = config.autoGroup !== undefined ? Boolean(config.autoGroup) : Boolean(settings.launcherAutoGroupTabs);

  let promptsToLaunch = [];
  if (config.launchMode === 'swarm') {
    const count = Math.min(60, Math.max(1, Number(config.swarmCount || 3)));
    const basePrompt = String(config.basePrompt || '').trim();
    if (!basePrompt) throw new Error('Informe o prompt para lançar o enxame.');
    for (let i = 0; i < count; i++) {
      promptsToLaunch.push(basePrompt);
    }
  } else if (config.launchMode === 'task_list') {
    const rawTasks = Array.isArray(config.tasks) ? config.tasks : [];
    promptsToLaunch = rawTasks.map((t) => String(t).trim()).filter(Boolean).slice(0, 60);
    if (!promptsToLaunch.length) throw new Error('Adicione pelo menos uma tarefa na lista.');
  } else if (config.launchMode === 'matrix') {
    const template = String(config.template || '').trim();
    const varName = String(config.variableName || 'item').trim();
    const values = (Array.isArray(config.variableValues) ? config.variableValues : [])
      .map((v) => String(v).trim())
      .filter(Boolean)
      .slice(0, 25);
    if (!template || !values.length) {
      throw new Error('Preencha o template e pelo menos um valor de variável.');
    }
    promptsToLaunch = values.map((val) => {
      const map = { [varName]: val };
      if (template.includes(`{{${varName}}}`)) {
        return AU_STORAGE.fillVariables(template, map);
      }
      return `${template}\n\nFoco / Item específico: ${val}`;
    });
  } else {
    throw new Error('Modo de lançamento desconhecido.');
  }

  const effectiveStagger = promptsToLaunch.length > 1 ? Math.max(3800, staggerMs) : staggerMs;
  const collabEnabled = Boolean(config.collabEnabled);
  const effectiveAutoLoop = collabEnabled ? true : autoEnableLoop;
  const refuseThinking =
    config.refuseThinkingModels !== undefined
      ? Boolean(config.refuseThinkingModels)
      : settings.refuseThinkingModels !== false;
  const autoDetectedSpecInBatch =
    !config.githubEnabled && settings.githubAutoDetectInPrompt !== false && AU_INTEGRATIONS.extractGithubRepoFromText
      ? AU_INTEGRATIONS.extractGithubRepoFromText(promptsToLaunch.join('\n'))
      : null;

  const wantGithub = Boolean(config.githubEnabled || autoDetectedSpecInBatch);
  const ghResolved = wantGithub
    ? await resolveAndPersistGithubInput(
        autoDetectedSpecInBatch && (!config.githubEnabled || !config.githubRepo)
          ? Object.assign({}, config, {
              githubRepo: autoDetectedSpecInBatch.webUrl,
              githubBaseBranch: autoDetectedSpecInBatch.branchFromUrl || config.githubBaseBranch
            })
          : config,
        settings
      )
    : null;
  if (config.githubEnabled && (!ghResolved || !ghResolved.spec)) {
    throw new Error(
      'Link ou repositório GitHub inválido. Cole o link completo (ex.: https://github.com/usuario/repositorio) ou usuario/repositorio.'
    );
  }
  const githubEnabled = Boolean(wantGithub && ghResolved && ghResolved.spec);
  const tempFilesEnabled =
    config.tempFilesEnabled !== undefined ? Boolean(config.tempFilesEnabled) : Boolean(settings.tempFilesEnabledInCollab);

  const selectedAuthMode = AU_DEFAULTS.normalizeGithubAuthMode(config.githubAuthMode || settings.githubAuthMode);
  const autoCreatePR =
    config.githubAutoCreatePR !== undefined
      ? Boolean(config.githubAutoCreatePR)
      : settings.githubAutoCreatePR !== false;
  const launchGithubRuntimeCfg = githubEnabled
    ? {
        enabled: true,
        repo: ghResolved.canonicalRepo,
        fullName: ghResolved.fullName,
        baseBranch: ghResolved.effectiveBaseBranch,
        authMode: selectedAuthMode,
        branchMode: config.githubBranchMode || settings.githubBranchMode || 'branch_per_agent_pr',
        sharedBranch: String(config.githubSharedBranch || '').trim(),
        defaultAgentAccessMode: config.githubDefaultAgentAccessMode || settings.githubDefaultAgentAccessMode || 'auto_role',
        qaReadOnly: Boolean(settings.githubQaReadOnly),
        allowExternalPrivateRepoUpload: Boolean(config.allowExternalPrivateRepoUpload),
        privateSnapshotPassphrase: String(config.privateSnapshotPassphrase || '').trim(),
        autoCreatePR,
        soloDirect: !collabEnabled && promptsToLaunch.length === 1,
        hasVaultCredential: Boolean(ghResolved && ghResolved.effectiveToken),
        repoSnapshotUrl: '',
        token: ''
      }
    : null;

  let collabRoom = null;
  const standaloneFilebinId =
    !collabEnabled &&
    (tempFilesEnabled ||
      (launchGithubRuntimeCfg &&
        (selectedAuthMode === 'extension_proxy_push' || selectedAuthMode === 'vault_broker_zero_token')))
      ? AU_INTEGRATIONS.generateFilebinId('batch')
      : '';

  if (collabEnabled) {
    const collabProfile = config.collabProfile || settings.collabDefaultProfile || 'specialists';
    const collabStopMode = config.collabStopMode || settings.collabDefaultStopMode || 'smart_consensus';
    const mirrorExternal =
      config.collabMirrorExternal !== undefined
        ? Boolean(config.collabMirrorExternal)
        : Boolean(settings.collabMirrorExternalTempChat);

    collabRoom = await createCollabRoom({
      baseTask: promptsToLaunch[0] || '',
      profile: collabProfile,
      stopMode: collabStopMode,
      mirrorExternal,
      refuseThinkingModels: refuseThinking,
      joinExternalCode: config.collabJoinExternalCode || '',
      agentCount: promptsToLaunch.length,
      integrationTimeoutMinutes:
        config.collabIntegrationTimeoutMinutes ||
        config.integrationTimeoutMinutes ||
        settings.collabIntegrationTimeoutMinutes ||
        25,
      githubEnabled,
      githubRepo: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.repo : '',
      githubToken: ghResolved ? ghResolved.effectiveToken : '',
      githubBaseBranch: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.baseBranch : 'main',
      githubAuthMode: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.authMode : 'vault_broker_zero_token',
      githubBranchMode: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.branchMode : 'branch_per_agent_pr',
      githubSharedBranch: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.sharedBranch : '',
      githubDefaultAgentAccessMode: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.defaultAgentAccessMode : 'auto_role'
    });

    if (
      launchGithubRuntimeCfg &&
      ghResolved &&
      ghResolved.effectiveToken &&
      (selectedAuthMode === 'extension_proxy_push' || selectedAuthMode === 'vault_broker_zero_token')
    ) {
      const snapUrl = await stageRepoSnapshotForProxyIfNeeded(
        launchGithubRuntimeCfg,
        ghResolved.effectiveToken,
        collabRoom.filebinId
      );
      if (snapUrl) {
        launchGithubRuntimeCfg.repoSnapshotUrl = snapUrl;
        if (collabRoom.githubConfig) collabRoom.githubConfig.repoSnapshotUrl = snapUrl;
      }
    }
  } else if (
    launchGithubRuntimeCfg &&
    ghResolved &&
    ghResolved.effectiveToken &&
    (selectedAuthMode === 'extension_proxy_push' || selectedAuthMode === 'vault_broker_zero_token')
  ) {
    const snapUrl = await stageRepoSnapshotForProxyIfNeeded(
      launchGithubRuntimeCfg,
      ghResolved.effectiveToken,
      standaloneFilebinId
    );
    if (snapUrl) {
      launchGithubRuntimeCfg.repoSnapshotUrl = snapUrl;
    }
  }

  function hasAnyCaptchaWaitingTab() {
    for (const st of TAB_STATES.values()) {
      if (st && st.status === 'captcha_waiting') return true;
    }
    return false;
  }

  async function waitWhileAnyTabHasCaptcha() {
    const startTs = Date.now();
    let sawCaptcha = false;
    while (hasAnyCaptchaWaitingTab()) {
      sawCaptcha = true;
      if (Date.now() - startTs >= 600000) break; // up to 10 minutes
      await sleep(600);
    }
    // Give 2.2s extra breather right after solving "Não sou um robô" so session cookie settles cleanly!
    if (sawCaptcha) {
      await sleep(2200);
    }
  }

  async function waitForTabToStartBeforeNext(tabId) {
    const startTs = Date.now();
    let lastNudgeAt = 0;
    while (true) {
      await sleep(500);
      // Verify tab still exists in browser (never rely on TAB_STATES alone!)
      try {
        await chrome.tabs.get(tabId);
      } catch (_) {
        PENDING_JOBS.delete(tabId);
        return;
      }

      const st = TAB_STATES.get(tabId);
      const isWaitingCaptcha = (st && st.status === 'captcha_waiting') || hasAnyCaptchaWaitingTab();
      const now = Date.now();
      const elapsed = now - startTs;

      // ALWAYS check Captcha FIRST! Never open the next tab while user is solving "Não sou um robô" (up to 10 min)!
      if (isWaitingCaptcha) {
        if (elapsed >= 600000) return;
        continue;
      }

      // Job confirmed typed & submitted (with zero active Captcha)!
      if (!PENDING_JOBS.has(tabId)) return;

      const job = PENDING_JOBS.get(tabId);
      if (job && now - lastNudgeAt >= 1200) {
        lastNudgeAt = now;
        job.lastPushAt = now;
        chrome.tabs.sendMessage(tabId, { type: 'AU_RUN_PENDING_JOB', job }).catch(() => {});
      }

      // Normal timeout (28s) when no captcha is shown
      if (elapsed >= 28000) {
        return;
      }
    }
  }

  const standaloneBatchCode = !collabEnabled ? AU_COLLAB.generateFourDigitCode(new Set(COLLAB_ROOMS.keys())) : '';

  // Spawn sequentially in background so Popup/Dashboard returns immediately AND every single tab (1, 2, 3, 4...) types & starts reliably
  (async () => {
    const createdTabIds = [];
    for (let i = 0; i < promptsToLaunch.length; i++) {
      // Never open the next tab if a late "Não sou um robô" modal appeared on any earlier tab!
      if (i > 0) {
        await waitWhileAnyTabHasCaptcha();
      }

      let initialCodebaseBriefing = '';
      if (launchGithubRuntimeCfg && launchGithubRuntimeCfg.fullName && typeof AU_STORAGE.getRepoMemory === 'function') {
        const repoMem = await AU_STORAGE.getRepoMemory(launchGithubRuntimeCfg.fullName).catch(() => null);
        if (repoMem && typeof AU_COLLAB.buildCodebaseBriefingBlock === 'function') {
          initialCodebaseBriefing = AU_COLLAB.buildCodebaseBriefingBlock(repoMem);
        }
      }

      const rawPromptText = promptsToLaunch[i];
      const role = collabRoom && collabRoom.roles ? collabRoom.roles[i] : null;
      let promptText = rawPromptText;
      let assignedGithubBranch = '';
      if (collabRoom && role) {
        const slotKey = `ag${i + 1}`;
        const roomVaultCaps = ensureRoomVaultCaps(collabRoom);
        const perAgentGhCfg = launchGithubRuntimeCfg
          ? Object.assign({}, launchGithubRuntimeCfg, {
              filebinId: collabRoom.filebinId || '',
              agentVaultCap: roomVaultCaps[slotKey] || '',
              token: ''
            })
          : null;
        assignedGithubBranch = perAgentGhCfg
          ? AU_COLLAB.computeAgentBranchName(collabRoom.roomId, role, perAgentGhCfg)
          : '';
        promptText = AU_COLLAB.buildInitialAgentPrompt({
          roomId: collabRoom.roomId,
          roomHmacKey: collabRoom.roomHmacKey || '',
          basePrompt: rawPromptText,
          agentKitEnabled: settings.agentKitEnabled === true,
          harnessEnabled: settings.harnessEnabled !== false,
          sessionTimerMinutes: settings.sessionMinTimerMinutes,
          agentRole: role,
          teamRoles: collabRoom.roles,
          profile: collabRoom.profile,
          stopMode: collabRoom.stopMode,
          sharedBoard: collabRoom.sharedBoard,
          integrationStatus: AU_COLLAB.computeRoomIntegrationStatus(collabRoom),
          codebaseBriefing: initialCodebaseBriefing,
          tempFileConfig: {
            enabled: tempFilesEnabled,
            filebinId: collabRoom.filebinId,
            litterboxExpiry: settings.litterboxExpiry || '24h'
          },
          githubConfig: perAgentGhCfg
        });
      } else if (launchGithubRuntimeCfg || tempFilesEnabled) {
        const soloRole = {
          index: i,
          agentIndex: i + 1,
          shortTitle: `Agente ${i + 1}`,
          roleTitle: `Executor #${i + 1}`,
          // Only mark single-agent launch as solo synthesizer; multi-tab swarm gives each tab its own independent branch!
          isSynthesizer: false
        };
        if (launchGithubRuntimeCfg) {
          assignedGithubBranch =
            launchGithubRuntimeCfg.branchMode === 'single_shared_branch' && !launchGithubRuntimeCfg.autoCreatePR
              ? launchGithubRuntimeCfg.baseBranch
              : promptsToLaunch.length === 1
                ? `au/pr-${standaloneBatchCode}`
                : `au/${standaloneBatchCode}/agent-${i + 1}`;
        }
        const perTabGhCfg = launchGithubRuntimeCfg
          ? Object.assign({}, launchGithubRuntimeCfg, {
              soloDirect: true,
              explicitBranch: assignedGithubBranch,
              token: ''
            })
          : null;
        const ghExtra = perTabGhCfg
          ? AU_COLLAB.buildGithubInstructions(perTabGhCfg, soloRole, standaloneBatchCode)
          : '';
        const tfExtra = tempFilesEnabled
          ? AU_COLLAB.buildTempFileHubInstructions({
              enabled: true,
              filebinId: standaloneFilebinId,
              litterboxExpiry: settings.litterboxExpiry || '24h'
            })
          : '';
        promptText = [rawPromptText, initialCodebaseBriefing, ghExtra, tfExtra].filter(Boolean).join('\n');
      }

      if (!collabRoom && settings.agentKitEnabled === true) {
        promptText = AU_AGENT_KIT.initial({
          roomId: 'solo_' + standaloneBatchCode, basePrompt: rawPromptText,
          profile: settings.autoContinueStrategy || 'hybrid', sessionTimerMinutes: settings.sessionMinTimerMinutes,
          harnessEnabled: settings.harnessEnabled !== false,
          agentRole: { index: i, agentIndex: i + 1, shortTitle: `Agente ${i+1}`, roleTitle: 'Executor' },
          githubConfig: launchGithubRuntimeCfg ? Object.assign({}, launchGithubRuntimeCfg, { explicitBranch: assignedGithubBranch }) : null
        });
      }

      if (!collabRoom && settings.agentKitEnabled !== true && settings.harnessEnabled !== false) {
        promptText += '\n' + AU_HARNESS.bootstrap({ roomId: 'solo_' + standaloneBatchCode, agentIndex: i + 1, mode: settings.autoContinueStrategy });
      }

      if (!collabRoom && settings.agentKitEnabled !== true && AU_COLLAB.buildSessionTimerInstructions) {
        promptText += '\n' + AU_COLLAB.buildSessionTimerInstructions({ sessionTimerMinutes: settings.sessionMinTimerMinutes, agentIndex: i + 1, hasChat: false });
      }

      if (typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.scrubSecrets) {
        promptText = AU_CRED_BROKER.scrubSecrets(promptText, ghResolved ? ghResolved.effectiveToken : '');
      }

      const tab = await chrome.tabs.create({
        url: targetUrl,
        active: true
      });
      createdTabIds.push(tab.id);
      const bindingEpoch = collabRoom ? nextTabBindingEpoch(tab.id) : 0;

      const jobObj = {
        jobId: 'job_' + i + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        initialPrompt: promptText,
        autoEnableLoop: effectiveAutoLoop,
        strategy: config.strategy || settings.autoContinueStrategy || 'hybrid',
        fixedPrompt: config.fixedPrompt || settings.fixedContinuePrompt,
        queue: Array.isArray(config.queueSteps) ? config.queueSteps.slice() : [],
        collabRoomId: collabRoom ? collabRoom.roomId : '',
        collabAgentName: role ? role.shortTitle : '',
        bindingEpoch,
        githubActive: Boolean(launchGithubRuntimeCfg),
        githubRepo: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.repo : '',
        githubBaseBranch: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.baseBranch : '',
        githubBranch: assignedGithubBranch,
        refuseThinkingModels: refuseThinking,
        rerollAttempt: 0,
        createdAt: Date.now(),
        lastPushAt: 0
      };

      SLOT_INITIAL_PROMPTS.set(tab.id, promptText);
      persistVolatileWorkerState();

      if (collabRoom && role) {
        collabRoom.agents.push({
          tabId: tab.id,
          bindingEpoch,
          index: i,
          name: role.shortTitle,
          roleTitle: role.roleTitle,
          roleDesc: role.roleDesc,
          isSynthesizer: role.isSynthesizer,
          githubAccessLevel: role.githubAccessLevel || 'auto_role',
          admittedToTeam: !refuseThinking,
          screeningStatus: refuseThinking ? 'screening' : 'admitted',
          refusedCount: 0,
          lastScreeningAt: Date.now(),
          lastSeenSeq: collabRoom.seq,
          lastTurnHash: '',
          waitingSince: 0,
          turnsCount: 0,
          closed: false
        });
        persistCollabRooms();
      }

      // Register PENDING_JOBS immediately before any await so no listener can miss it!
      PENDING_JOBS.set(tab.id, jobObj);
      persistVolatileWorkerState();

      TAB_STATES.set(tab.id, {
        tabId: tab.id,
        windowId: tab.windowId,
        url: targetUrl,
        title: role ? `${role.shortTitle} • TempChat #${collabRoom.roomId}` : `Agent #${i + 1} • Inicializando...`,
        mode: 'agent',
        autoContinueEnabled: effectiveAutoLoop,
        strategy: config.strategy || settings.autoContinueStrategy || 'hybrid',
        status: 'queued',
        loopsCount: 0,
        queueLength: Array.isArray(config.queueSteps) ? config.queueSteps.length : 0,
        estimatedTokens: AU_STORAGE.estimateTokens(promptText),
        lastActivityAt: Date.now(),
        stopReason: '',
        collabRoomId: collabRoom ? collabRoom.roomId : '',
        collabAgentName: role ? role.shortTitle : '',
        bindingEpoch,
        githubActive: Boolean(launchGithubRuntimeCfg),
        githubRepo: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.repo : '',
        githubBaseBranch: launchGithubRuntimeCfg ? launchGithubRuntimeCfg.baseBranch : '',
        githubBranch: assignedGithubBranch
      });

      ensureAntiThrottleHeartbeat();
      await refreshExtensionBadge();

      // Wait until THIS tab has actually typed, solved any Captcha, AND started its Agent BEFORE grouping or opening next tab!
      await waitForTabToStartBeforeNext(tab.id);

      if (autoGroup && createdTabIds.length > 1) {
        await groupTabsSafely(
          createdTabIds,
          collabRoom
            ? `🤝 TempChat #${collabRoom.roomId}`
            : config.groupName || settings.launcherTabGroupName || 'Arena Ultra • Agents',
          collabRoom ? 'cyan' : settings.launcherTabGroupColor || 'green'
        );
      }

      if (i < promptsToLaunch.length - 1) {
        await sleep(effectiveStagger);
        // Re-check right after stagger in case Security Verification appeared late!
        await waitWhileAnyTabHasCaptcha();
      }
    }
  })().catch(() => {});

  await AU_STORAGE.updateMetrics((m) => {
    m.totalBatchesLaunched = (m.totalBatchesLaunched || 0) + 1;
    m.totalAgentTabsSpawned = (m.totalAgentTabsSpawned || 0) + promptsToLaunch.length;
    return m;
  });

  await AU_STORAGE.appendSessionLog({
    tabTitle: collabRoom
      ? `🤝 Sala TempChat #${collabRoom.roomId} (${promptsToLaunch.length} agentes)`
      : `Lote Multi-Agent (${promptsToLaunch.length} abas)`,
    url: targetUrl,
    eventType: 'batch_launch',
    loopsCount: 0,
    details: collabRoom
      ? `Modo Colaboração TempChat #${collabRoom.roomId} (${collabRoom.profile}) • ${promptsToLaunch.length} agentes conectados`
      : `Modo: ${config.launchMode} • Fila Anti-reCAPTCHA Ativa • Auto-Continue: ${autoEnableLoop ? 'Ligado' : 'Desligado'}`
  });

  await refreshExtensionBadge();
  ensureAntiThrottleHeartbeat();

  return {
    launchedCount: promptsToLaunch.length,
    tabIds: [],
    roomId: collabRoom ? collabRoom.roomId : ''
  };
}

async function splitArenaTabsIntoGrid() {
  await syncOpenArenaTabs();
  const arenaTabs = Array.from(TAB_STATES.values()).slice(0, 4);
  if (arenaTabs.length < 2) {
    return { ok: false, reason: 'Abra pelo menos 2 abas do Arena.ai para dividir lado a lado.' };
  }

  let screenWidth = 1600;
  let screenHeight = 960;
  try {
    const currentWin = await chrome.windows.getCurrent();
    if (currentWin && currentWin.width && currentWin.height) {
      screenWidth = Math.max(1200, currentWin.width);
      screenHeight = Math.max(760, currentWin.height);
    }
  } catch (_) {}

  const count = arenaTabs.length;
  const cols = count <= 2 ? 2 : 2;
  const rows = count <= 2 ? 1 : 2;
  const w = Math.floor(screenWidth / cols);
  const h = Math.floor(screenHeight / rows);

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = col * w;
    const top = row * h;
    const tabId = arenaTabs[i].tabId;

    try {
      if (chrome.tabs && typeof chrome.tabs.ungroup === 'function') {
        await chrome.tabs.ungroup(tabId).catch(() => {});
      }
      await chrome.windows.create({
        tabId,
        left,
        top,
        width: w,
        height: h,
        focused: i === 0
      });
    } catch (_) {}
  }
  return { ok: true, tiledCount: count };
}

// Persistent Keep-Alive Port Connections from Content Scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'au-keepalive') return;
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  if (!tabId) return;

  ACTIVE_PORTS.set(tabId, port);
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'AU_HEARTBEAT_PONG') {
      // Receiving Port traffic from content scripts resets Chromium MV3's 30s Service Worker idle timer!
      if (msg.state) {
        const existing = TAB_STATES.get(tabId) || { tabId };
        const changedMeaningfully =
          Boolean(existing.autoContinueEnabled) !== Boolean(msg.state.autoContinueEnabled) ||
          existing.status !== msg.state.status ||
          Number(existing.loopsCount || 0) !== Number(msg.state.loopsCount || 0) ||
          Number(existing.queueLength || 0) !== Number(msg.state.queueLength || 0) ||
          (existing.stopReason || '') !== (msg.state.stopReason || '');
        TAB_STATES.set(tabId, mergeTabStatePreservingRoomAuthority(tabId, existing, msg.state));
        if (changedMeaningfully) {
          persistTabStates();
        }
      }
      ensureAntiThrottleHeartbeat();
      return;
    }
    if (msg.type === 'AU_TAB_STATE_UPDATE' && msg.state) {
      const existing = TAB_STATES.get(tabId) || { tabId };
      TAB_STATES.set(tabId, mergeTabStatePreservingRoomAuthority(tabId, existing, msg.state));
      persistTabStates();
      refreshExtensionBadge();
      ensureAntiThrottleHeartbeat();
    }
  });
  port.onDisconnect.addListener(() => {
    ACTIVE_PORTS.delete(tabId);
  });
});

// Message Router for Content Scripts, Popup & Dashboard
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'AU_BG_SLEEP') {
    const waitMs = Math.min(15000, Math.max(10, Number(msg.ms) || 100));
    setTimeout(() => {
      try {
        sendResponse({ ok: true });
      } catch (_) {}
    }, waitMs);
    return true;
  }

  if (msg && msg.type === 'AU_OFFSCREEN_TICK') {
    broadcastTickToActiveTabs();
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.type === 'AU_ENSURE_MAIN_BRIDGE') {
    const tId = sender && sender.tab ? sender.tab.id : null;
    if (tId && chrome.scripting) {
      chrome.scripting
        .executeScript({
          target: { tabId: tId },
          world: 'MAIN',
          files: ['content/page-bridge.js']
        })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  (async () => {
    if (!msg || !msg.type) {
      sendResponse({ ok: false });
      return;
    }

    const senderTabId = sender && sender.tab ? sender.tab.id : null;
    await ensureVolatileWorkerStateLoaded();

    switch (msg.type) {
      case 'AU_CONTENT_READY': {
        if (!senderTabId) {
          sendResponse({ ok: false });
          return;
        }
        await ensureCollabRoomsLoaded();
        // Keep pendingJob in PENDING_JOBS until AU_CONFIRM_JOB_STARTED arrives!
        const pendingJob = PENDING_JOBS.get(senderTabId) || null;
        if (pendingJob) {
          pendingJob.lastPushAt = Date.now();
        }
        const effectiveUrl = (msg.initialState && msg.initialState.url) || sender.tab.url || '';
        const convKey = extractConvKey(effectiveUrl);
        const persisted = await loadPersistedTabStates();
        const saved = persisted.byTab[senderTabId] || (convKey ? persisted.byConv[convKey] : null) || {};
        const existing = TAB_STATES.get(senderTabId) || {};

        // ARENA-18: Verify room binding strictly against COLLAB_ROOMS membership for senderTabId!
        let verifiedRoomId = existing.collabRoomId || '';
        let verifiedAgentName = existing.collabAgentName || '';
        let verifiedEpoch = existing.bindingEpoch || 0;
        const candidateRoomId = verifiedRoomId || (pendingJob && pendingJob.collabRoomId) || saved.collabRoomId || '';
        if (candidateRoomId && COLLAB_ROOMS.has(candidateRoomId)) {
          const rCheck = COLLAB_ROOMS.get(candidateRoomId);
          const agCheck = (rCheck.agents || []).find((a) => a && a.tabId === senderTabId && !a.closed);
          if (agCheck && rCheck.status !== 'closed') {
            verifiedRoomId = rCheck.roomId;
            verifiedAgentName = agCheck.name || '';
            verifiedEpoch = agCheck.bindingEpoch || 1;
          } else {
            verifiedRoomId = '';
            verifiedAgentName = '';
            verifiedEpoch = 0;
          }
        } else {
          verifiedRoomId = '';
          verifiedAgentName = '';
          verifiedEpoch = 0;
        }

        const nextState = Object.assign(
          {
            tabId: senderTabId,
            windowId: sender.tab.windowId,
            url: effectiveUrl,
            title: (msg.initialState && msg.initialState.title) || sender.tab.title || 'Arena.ai',
            mode: (msg.initialState && msg.initialState.mode) || detectModeFromUrl(effectiveUrl),
            autoContinueEnabled: false,
            strategy: 'hybrid',
            customFixedPrompt: '',
            promptQueue: [],
            status: 'idle',
            loopsCount: 0,
            queueLength: 0,
            estimatedTokens: 0,
            stopReason: ''
          },
          saved,
          existing,
          {
            tabId: senderTabId,
            windowId: sender.tab.windowId,
            url: effectiveUrl || existing.url || '',
            title: (msg.initialState && msg.initialState.title) || sender.tab.title || existing.title || 'Arena.ai',
            mode: (msg.initialState && msg.initialState.mode) || detectModeFromUrl(effectiveUrl),
            collabRoomId: verifiedRoomId,
            collabAgentName: verifiedAgentName,
            bindingEpoch: verifiedEpoch,
            lastActivityAt: Date.now()
          }
        );

        TAB_STATES.set(senderTabId, nextState);
        if (nextState.autoContinueEnabled) {
          protectTabFromFreeze(senderTabId, true);
        }
        persistTabStates();
        await refreshExtensionBadge();
        ensureAntiThrottleHeartbeat();
        const readySettings = await AU_STORAGE.getSettings();
        const hasVaultToken = Boolean(getActiveVaultToken(verifiedRoomId, readySettings));
        sendResponse({
          ok: true,
          tabId: senderTabId,
          hasVaultToken,
          pendingJob,
          pendingArchiveIds: Array.from(PENDING_ARCHIVE_IDS),
          restoredState: Object.assign(serializeAutopilotSnapshot(nextState), {
            bindingEpoch: verifiedEpoch
          })
        });
        break;
      }

      case 'AU_CONFIRM_ARCHIVED_IDS': {
        if (Array.isArray(msg.ids)) {
          for (const id of msg.ids) {
            PENDING_ARCHIVE_IDS.delete(String(id));
          }
          persistVolatileWorkerState();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_RECOVER_DEAD_SESSION': {
        const targetId = msg.tabId || senderTabId;
        if (!targetId) {
          sendResponse({ ok: false });
          return;
        }
        const p = msg.payload || {};
        const st = TAB_STATES.get(targetId) || { tabId: targetId };
        const settings = await AU_STORAGE.getSettings();
        const promptForRecovery = String(p.initialPrompt || SLOT_INITIAL_PROMPTS.get(targetId) || '').trim();
        let deadConvId = String(p.convId || '').trim();
        if (!deadConvId && st.url) {
          const ck = extractConvKey(st.url);
          if (ck) deadConvId = ck.replace(/^\//, '');
        }
        if (deadConvId && !p.archived) {
          PENDING_ARCHIVE_IDS.add(deadConvId);
        }
        if (!promptForRecovery) {
          persistVolatileWorkerState();
          sendResponse({ ok: false, error: 'Sem prompt salvo para reabrir.' });
          return;
        }
        SLOT_INITIAL_PROMPTS.set(targetId, promptForRecovery);
        persistVolatileWorkerState();
        const recoveryJob = {
          jobId: `recover_dead_${targetId}_${Date.now()}`,
          initialPrompt: promptForRecovery,
          autoEnableLoop: p.autoContinueEnabled !== undefined ? Boolean(p.autoContinueEnabled) : Boolean(st.autoContinueEnabled),
          strategy: p.strategy || st.strategy || settings.autoContinueStrategy || 'hybrid',
          fixedPrompt: p.fixedPrompt || st.customFixedPrompt || settings.fixedContinuePrompt,
          queue: Array.isArray(p.queue) ? p.queue.slice() : [],
          collabRoomId: p.collabRoomId || st.collabRoomId || '',
          collabAgentName: p.collabAgentName || st.collabAgentName || '',
          githubActive: p.githubActive !== undefined ? Boolean(p.githubActive) : Boolean(st.githubActive),
          githubRepo: p.githubRepo || st.githubRepo || '',
          githubBaseBranch: p.githubBaseBranch || st.githubBaseBranch || '',
          githubBranch: p.githubBranch || st.githubBranch || '',
          refuseThinkingModels:
            p.refuseThinkingModels !== undefined ? Boolean(p.refuseThinkingModels) : settings.refuseThinkingModels !== false,
          rerollAttempt: Number(st.thinkingRefusedCount || 0),
          createdAt: Date.now(),
          lastPushAt: 0
        };
        PENDING_JOBS.set(targetId, recoveryJob);
        persistVolatileWorkerState();
        scheduleSafeRerollNavigation(targetId, 'https://arena.ai/agent');
        sendResponse({ ok: true, action: 'reopening_clean_agent' });
        break;
      }

      case 'AU_CONFIRM_JOB_STARTED': {
        if (senderTabId) {
          if (PENDING_JOBS.delete(senderTabId)) {
            persistVolatileWorkerState();
          }
          ensureAntiThrottleHeartbeat();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_FOCUS_CAPTCHA_TAB': {
        if (senderTabId) {
          try {
            const tab = await chrome.tabs.update(senderTabId, { active: true });
            if (tab && tab.windowId) {
              await chrome.windows.update(tab.windowId, { focused: true });
            }
          } catch (_) {}
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_TAB_STATE_UPDATE': {
        const targetId = msg.tabId || senderTabId;
        if (targetId) {
          const prev = TAB_STATES.get(targetId) || { tabId: targetId };
          // Only allow explicit UI room updates if senderTabId is null (privileged extension page) AND msg.allowRoomOverride is true; content scripts NEVER overwrite room binding!
          const merged =
            !senderTabId && msg.allowRoomOverride
              ? Object.assign({}, prev, msg.state || {}, { tabId: targetId, lastActivityAt: Date.now() })
              : mergeTabStatePreservingRoomAuthority(targetId, prev, msg.state || {});
          TAB_STATES.set(targetId, merged);
          persistTabStates();
          await refreshExtensionBadge();
          ensureAntiThrottleHeartbeat();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_RECORD_LOOP_SENT': {
        const targetId = senderTabId;
        const promptTokens = Number(msg.promptTokens || 0);
        const outputTokens = Number(msg.outputTokens || 0);
        const settings = await AU_STORAGE.getSettings();
        const safePreview = AU_INTEGRATIONS.scrubSecrets(
          String(msg.promptPreview || '').slice(0, 90),
          getActiveVaultToken('', settings)
        );
        await AU_STORAGE.updateMetrics((m) => {
          m.totalAutoLoopsSent = (m.totalAutoLoopsSent || 0) + 1;
          m.estimatedPromptTokens = (m.estimatedPromptTokens || 0) + promptTokens;
          m.estimatedOutputTokens = (m.estimatedOutputTokens || 0) + outputTokens;
          return m;
        });
        await AU_STORAGE.appendSessionLog({
          tabTitle: (sender && sender.tab && sender.tab.title) || msg.tabTitle || 'Arena Agent',
          url: (sender && sender.tab && sender.tab.url) || msg.url || '',
          eventType: 'loop_sent',
          loopsCount: Number(msg.loopsCount || 1),
          details: `Prompt enviado (${msg.source || 'auto'}): "${safePreview}"`
        });
        if (targetId && TAB_STATES.has(targetId)) {
          const st = TAB_STATES.get(targetId);
          st.loopsCount = Number(msg.loopsCount || (st.loopsCount + 1));
          TAB_STATES.set(targetId, st);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_TOKEN_LIMIT_STOP': {
        if (senderTabId) {
          await handleTokenLimitStop(senderTabId, msg.report || {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_GET_MISSION_CONTROL': {
        await ensureCollabRoomsLoaded();
        await syncAllActiveCollabRoomsRealtime();
        await syncOpenArenaTabs();
        const tabsList = Array.from(TAB_STATES.values()).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
        const metrics = await AU_STORAGE.getMetrics();
        const collabRooms = Array.from(COLLAB_ROOMS.values())
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .map((r) => serializeRoomForClient(r));
        sendResponse({ ok: true, tabs: tabsList, metrics, collabRooms });
        break;
      }

      case 'AU_COLLAB_GET_ROOMS': {
        await ensureCollabRoomsLoaded();
        await syncAllActiveCollabRoomsRealtime();
        await syncOpenArenaTabs();
        if (msg.roomId) {
          const room = COLLAB_ROOMS.get(String(msg.roomId));
          sendResponse({ ok: Boolean(room), room: serializeRoomForClient(room) });
        } else {
          const rooms = Array.from(COLLAB_ROOMS.values())
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .map((r) => serializeRoomForClient(r));
          sendResponse({ ok: true, rooms });
        }
        break;
      }

      case 'AU_COLLAB_CREATE_FROM_OPEN_TABS': {
        try {
          const room = await createCollabRoomFromOpenTabs(msg.options || {});
          sendResponse({ ok: true, room });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_COLLAB_TURN_COMPLETED': {
        if (!senderTabId) {
          sendResponse({ ok: false, action: 'fallback_normal' });
          return;
        }
        try {
          const decision = await handleCollabTurnCompleted(senderTabId, msg.payload || {});
          sendResponse(decision);
        } catch (err) {
          sendResponse({ ok: false, action: 'fallback_normal', error: err.message || String(err) });
        }
        break;
      }

      case 'AU_COLLAB_SEND_COORDINATOR_MSG': {
        await ensureCollabRoomsLoaded();
        const room = COLLAB_ROOMS.get(String(msg.roomId || ''));
        const rawText = String(msg.text || '').trim();
        if (!room || !rawText) {
          sendResponse({ ok: false, error: 'Sala TempChat ou mensagem inválida.' });
          return;
        }
        const targetTabId = msg.targetTabId ? Number(msg.targetTabId) : null;
        const targetAgent = targetTabId ? (room.agents || []).find((a) => a.tabId === targetTabId) : null;
        const text = targetAgent && !rawText.startsWith('@') ? `@${targetAgent.name}: ${rawText}` : rawText;

        if (room.status === 'completed' || room.status === 'paused' || room.status === 'needs_human') {
          room.status = 'active';
          room.needsHumanReason = '';
        }
        const coordSettings = await AU_STORAGE.getSettings();
        const coordToken = getActiveVaultToken(room.roomId, coordSettings);
        await appendRoomMessage(
          room,
          {
            senderType: 'user',
            senderName: 'Coordenador (Você)',
            senderRole: targetAgent ? `Direto para ${targetAgent.name}` : 'Direção Humana',
            text
          },
          true,
          coordToken
        );

        // Publish Coordinator message to real-time Filebin bus so Agents currently mid-turn in bash receive it in <1s via `/tmp/au_chat read`!
        pushRealtimeMessageToBin(room, {
          senderName: 'Coordenador (Você)',
          senderRole: targetAgent ? `Direto para ${targetAgent.name}` : 'Direção Humana',
          tag: 'coord',
          text
        }).catch(() => {});

        // Wake or directly inject into idle/paused Agents so they immediately answer your Chat Live message!
        if (msg.wakeAgents !== false) {
          for (const ag of room.agents || []) {
            if (ag.closed) continue;
            if (targetTabId && ag.tabId !== targetTabId) continue;
            ag.waitingSince = 0;
            const st = TAB_STATES.get(ag.tabId);
            if (!st || st.status === 'token_stopped') continue;

            const isIdleNow = st.status !== 'generating' && st.status !== 'queued' && !PENDING_JOBS.has(ag.tabId);
            st.autoContinueEnabled = true;
            TAB_STATES.set(ag.tabId, st);

            if (isIdleNow && msg.directPromptIfIdle !== false) {
              const directLivePrompt = [
                `💬 [MENSAGEM AO VIVO DO COORDENADOR HUMANO NO CHAT LIVE • SALA #${room.roomId}]:`,
                `"${text}"`,
                '',
                'Responda e aplique esta orientação agora mesmo em coordenação com seus colegas via `/tmp/au_chat send "..."` e publique seu resumo em `[TEMPCHAT] ... [/TEMPCHAT]`!'
              ].join('\n');
              sendTabMessageGroupSafe(
                ag.tabId,
                {
                  type: 'AU_EXECUTE_TAB_COMMAND',
                  command: 'send_prompt',
                  payload: { prompt: directLivePrompt }
                },
                2000
              ).catch(() => {});
            } else {
              sendTabMessageGroupSafe(
                ag.tabId,
                {
                  type: 'AU_EXECUTE_TAB_COMMAND',
                  command: 'resume',
                  payload: {}
                },
                1600
              ).catch(() => {});
            }
          }
          persistTabStates();
          ensureAntiThrottleHeartbeat();
          await refreshExtensionBadge();
        }
        sendResponse({ ok: true, room: serializeRoomForClient(room) });
        break;
      }

      case 'AU_COLLAB_SET_ROOM_STATE': {
        await ensureCollabRoomsLoaded();
        const room = COLLAB_ROOMS.get(String(msg.roomId || ''));
        if (!room) {
          sendResponse({ ok: false, error: 'Sala TempChat não encontrada.' });
          return;
        }
        if (msg.stopMode && (msg.stopMode === 'smart_consensus' || msg.stopMode === 'endless_tokens')) {
          room.stopMode = msg.stopMode;
          if (msg.stopMode === 'endless_tokens' && room.status === 'completed') {
            room.status = 'active';
          }
        }
        if (msg.refuseThinkingModels !== undefined) {
          room.refuseThinkingModels = Boolean(msg.refuseThinkingModels);
          if (!room.refuseThinkingModels) {
            for (const ag of room.agents || []) {
              if (!ag.admittedToTeam && ag.screeningStatus !== 'refused_stopped') {
                ag.admittedToTeam = true;
                ag.screeningStatus = 'admitted';
              }
            }
          }
          for (const ag of room.agents || []) {
            if (!ag.closed && ag.tabId) {
              sendTabMessageGroupSafe(
                ag.tabId,
                { type: 'AU_EXECUTE_TAB_COMMAND', command: 'apply_settings', payload: {} },
                1500
              ).catch(() => {});
            }
          }
        }
        if (msg.status && ['active', 'paused', 'needs_human', 'completed', 'closed'].includes(msg.status)) {
          room.status = msg.status;
          if (msg.status === 'active') {
            room.needsHumanReason = '';
          }
          if (msg.status === 'closed') {
            for (const ag of room.agents || []) {
              const st = TAB_STATES.get(ag.tabId);
              if (st && st.collabRoomId === room.roomId) {
                st.collabRoomId = '';
                st.collabAgentName = '';
                st.bindingEpoch = nextTabBindingEpoch(ag.tabId);
                TAB_STATES.set(ag.tabId, st);
              }
              chrome.tabs
                .sendMessage(ag.tabId, {
                  type: 'AU_EXECUTE_TAB_COMMAND',
                  command: 'leave_collab_room',
                  payload: { roomId: room.roomId }
                })
                .catch(() => {});
            }
            if (room.externalTabId) {
              EXT_TAB_TO_ROOM.delete(room.externalTabId);
              EXT_TAB_BINDING_TOKENS.delete(room.externalTabId);
            }
            COLLAB_ROOMS.delete(room.roomId);
            const delTok = ROOM_GITHUB_TOKENS.delete(room.roomId);
            const delCaps = ROOM_VAULT_CAPS.delete(room.roomId);
            if (delTok || delCaps) {
              persistVolatileWorkerState();
            }
            persistCollabRooms(true);
            persistTabStates(true);
            await refreshExtensionBadge();
            sendResponse({ ok: true, deleted: true });
            return;
          }
        }
        if (msg.openExternalBridge) {
          await openExternalTempChatBridgeTab(room, msg.joinExternalCode || '');
          if (room.externalTabId && msg.focusExternalTab) {
            try {
              const extT = await chrome.tabs.update(room.externalTabId, { active: true });
              if (extT && extT.windowId) {
                await chrome.windows.update(extT.windowId, { focused: true });
              }
            } catch (_) {}
          }
        }
        room.updatedAt = Date.now();
        persistCollabRooms(true);
        await refreshExtensionBadge();
        sendResponse({ ok: true, room: serializeRoomForClient(room) });
        break;
      }

      case 'AU_TEMPCHAT_BRIDGE_READY': {
        await ensureCollabRoomsLoaded();
        // ARENA-18: NEVER accept msg.roomId from URL hash or external tab payload!
        // Only tabs explicitly spawned & registered in EXT_TAB_TO_ROOM by SW may bind.
        const boundRoomId = senderTabId && EXT_TAB_TO_ROOM.has(senderTabId) ? EXT_TAB_TO_ROOM.get(senderTabId) : '';
        const room = boundRoomId ? COLLAB_ROOMS.get(boundRoomId) : null;
        if (room && senderTabId) {
          room.externalTabId = senderTabId;
          room.mirrorExternal = true;
          if (msg.externalCode) room.externalCode = String(msg.externalCode).trim();
          const bindingToken = getOrCreateExtTabBindingToken(senderTabId);
          const bindingEpoch = nextTabBindingEpoch(senderTabId);
          persistCollabRooms();
          sendResponse({
            ok: true,
            roomId: room.roomId,
            bindingToken,
            bindingEpoch
          });
        } else {
          sendResponse({ ok: false, unbound: true });
        }
        break;
      }

      case 'AU_TEMPCHAT_CODE_DETECTED': {
        await ensureCollabRoomsLoaded();
        const rId = senderTabId && EXT_TAB_TO_ROOM.has(senderTabId) ? EXT_TAB_TO_ROOM.get(senderTabId) : '';
        const expectedTok = senderTabId ? EXT_TAB_BINDING_TOKENS.get(senderTabId) : '';
        if (!rId || (expectedTok && msg.bindingToken && msg.bindingToken !== expectedTok)) {
          sendResponse({ ok: false, rejected: true });
          break;
        }
        const room = COLLAB_ROOMS.get(rId);
        if (room && msg.externalCode) {
          const prevCode = room.externalCode;
          room.externalCode = String(msg.externalCode).trim();
          if (prevCode !== room.externalCode) {
            await appendRoomMessage(
              room,
              {
                senderType: 'system',
                senderName: 'tempchat.online',
                text: `🌐 Ponte tempchat.online ativa! Código externo de 4 dígitos: #${room.externalCode}`
              },
              false
            );
          }
          persistCollabRooms();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_TEMPCHAT_INBOUND_MSG': {
        await ensureCollabRoomsLoaded();
        const rId = senderTabId && EXT_TAB_TO_ROOM.has(senderTabId) ? EXT_TAB_TO_ROOM.get(senderTabId) : '';
        const expectedTok = senderTabId ? EXT_TAB_BINDING_TOKENS.get(senderTabId) : '';
        if (!rId || (expectedTok && msg.bindingToken && msg.bindingToken !== expectedTok)) {
          sendResponse({ ok: false, rejected: true });
          break;
        }
        const room = COLLAB_ROOMS.get(rId);
        const rawText = String(msg.text || '').trim();
        const safeText = rawText
          .replace(/\[(?:GITHUB_PUSH_PRONTO|ENTREGA_FINAL_PRONTA|ATRIBUICAO_UNICA|CONTRATO_UNICO|VOTO_CONSENSO|ARQUIVO_COMPARTILHADO)[^\]]*\]/gi, '[TAG_EXTERNA_BLOQUEADA]')
          .trim();
        if (room && safeText) {
          if (room.status === 'completed') room.status = 'active';
          await appendRoomMessage(
            room,
            {
              senderType: 'external',
              senderName: `⛔ tempchat.online #${room.externalCode || room.roomId}`,
              senderRole: 'Fonte externa não verificada',
              externalUnverified: true,
              text: safeText
            },
            false
          );
          for (const ag of room.agents || []) {
            ag.waitingSince = 0;
          }
        }
        sendResponse({ ok: true });
        break;
      }

      // =====================================================================
      // v3.4.0 COLLAB SHARED BOARD, CENTRAL RBAC & INTEGRATION SLA RPCs
      // =====================================================================
      case 'AU_COLLAB_UPSERT_BOARD_ITEM': {
        await ensureCollabRoomsLoaded();
        const room = COLLAB_ROOMS.get(String(msg.roomId || ''));
        if (!room) {
          sendResponse({ ok: false, error: 'Sala TempChat não encontrada.' });
          return;
        }
        ensureRoomBoardInitialized(room);
        let changed = false;
        if (msg.itemType === 'assignment') {
          const r = AU_COLLAB.upsertBoardAssignment(
            room.sharedBoard,
            msg.slotKey || 'ag1',
            msg.patch || {},
            msg.authorName || 'Coordenador (Você)'
          );
          changed = Boolean(r && r.changed);
        } else if (msg.itemType === 'contract') {
          const r = AU_COLLAB.upsertBoardContract(
            room.sharedBoard,
            msg.key || '',
            msg.patch || {},
            msg.authorName || 'Coordenador (Você)'
          );
          changed = Boolean(r && r.changed);
        }
        if (changed) {
          room.updatedAt = Date.now();
          await checkAndAnnounceIntegrationReadiness(room);
          await publishBoardStateToBin(room);
          persistCollabRooms(true);
          notifyLiveChatRoomDelta(room, null);
        }
        sendResponse({ ok: true, changed, room: serializeRoomForClient(room) });
        break;
      }

      case 'AU_COLLAB_SET_AGENT_ACCESS': {
        await ensureCollabRoomsLoaded();
        const room = COLLAB_ROOMS.get(String(msg.roomId || ''));
        if (!room) {
          sendResponse({ ok: false, error: 'Sala TempChat não encontrada.' });
          return;
        }
        const validLevels = new Set(['auto_role', 'push_and_pr', 'push_branch', 'read_only', 'revoked']);
        const nextLevel = validLevels.has(String(msg.accessLevel || '')) ? String(msg.accessLevel) : 'auto_role';
        const targetTabId = msg.tabId ? Number(msg.tabId) : null;
        const targetIndex = msg.agentIndex !== undefined ? Number(msg.agentIndex) : -1;

        if (msg.applyToDefault && room.githubConfig) {
          room.githubConfig.defaultAgentAccessMode = nextLevel;
        } else {
          const ag = (room.agents || []).find(
            (a) => (targetTabId && a.tabId === targetTabId) || (targetIndex >= 0 && a.index === targetIndex)
          );
          if (ag) {
            ag.githubAccessLevel = nextLevel;
            const slotKey = `ag${Number(ag.index || 0) + 1}`;
            if (room.roles && room.roles[ag.index]) {
              room.roles[ag.index].githubAccessLevel = nextLevel;
            }
            // Rotate Vault capability nonce immediately when revoking so previously issued /tmp/au_gh caps stop working on the spot!
            if (nextLevel === 'revoked') {
              const caps = ensureRoomVaultCaps(room);
              caps[slotKey] = generateVaultCap();
              ROOM_VAULT_CAPS.set(String(room.roomId), caps);
              persistVolatileWorkerState();
            }
          }
        }
        room.updatedAt = Date.now();
        persistCollabRooms(true);
        notifyLiveChatRoomDelta(room, null);
        sendResponse({ ok: true, room: serializeRoomForClient(room) });
        break;
      }

      case 'AU_COLLAB_SET_INTEGRATION_SLA': {
        await ensureCollabRoomsLoaded();
        const room = COLLAB_ROOMS.get(String(msg.roomId || ''));
        if (!room) {
          sendResponse({ ok: false, error: 'Sala TempChat não encontrada.' });
          return;
        }
        const now = Date.now();
        if (msg.addMinutes) {
          const addMs = Number(msg.addMinutes) * 60000;
          const base = Math.max(now, Number(room.integrationDeadlineAt || now));
          room.integrationDeadlineAt = base + addMs;
          room.integrationTimeoutMinutes = Math.max(
            3,
            Math.round((room.integrationDeadlineAt - Number(room.createdAt || now)) / 60000)
          );
          if (room.lastAnnouncedIntegrationState === 'timed_out_ready') {
            room.lastAnnouncedIntegrationState = '';
          }
        } else if (msg.timeoutMinutes) {
          const mins = Math.max(3, Number(msg.timeoutMinutes));
          room.integrationTimeoutMinutes = mins;
          room.integrationDeadlineAt = now + mins * 60000;
          if (room.lastAnnouncedIntegrationState === 'timed_out_ready') {
            room.lastAnnouncedIntegrationState = '';
          }
        }
        if (msg.maxRounds !== undefined) {
          room.maxRoundsBeforeSynthesis = Math.max(2, Number(msg.maxRounds));
        }
        if (msg.forceReady !== undefined) {
          room.forceReadyForSynthesis = Boolean(msg.forceReady);
          if (room.forceReadyForSynthesis) {
            await checkAndAnnounceIntegrationReadiness(room);
            for (const ag of room.agents || []) {
              ag.waitingSince = 0;
            }
          }
        }
        room.updatedAt = now;
        await publishBoardStateToBin(room);
        persistCollabRooms(true);
        notifyLiveChatRoomDelta(room, null);
        sendResponse({ ok: true, room: serializeRoomForClient(room) });
        break;
      }

      // =====================================================================
      // GITHUB INTEGRATION, CREDENTIAL INSPECTOR & ZERO-TOKEN VAULT RPCs
      // =====================================================================
      case 'AU_GITHUB_VERIFY_TOKEN': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const token = AU_INTEGRATIONS.normalizeGithubToken(
            msg.token !== undefined ? msg.token : getActiveVaultToken('', settings)
          );
          const info = await AU_INTEGRATIONS.github.verifyToken(token);
          if (msg.saveToken && token) {
            await setGlobalVaultToken(token);
            await AU_STORAGE.saveSettings({
              githubUsername: info.login || ''
            });
          } else if (token) {
            VAULT_CREDENTIAL_META.storedAt = Date.now();
            VAULT_CREDENTIAL_META.revokedAt = 0;
            persistVolatileWorkerState();
          }
          const vaultSession = getVaultSessionStatus(settings, Boolean(token));
          sendResponse(Object.assign({ ok: true, vaultSession }, info));
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GITHUB_INSPECT_TOKEN': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const explicitTok = msg.token !== undefined ? AU_INTEGRATIONS.normalizeGithubToken(msg.token) : '';
          if (explicitTok) {
            await setGlobalVaultToken(explicitTok);
          }
          const rawTok = explicitTok || getActiveVaultToken('', settings);
          const repoInput = String(msg.repo !== undefined ? msg.repo : settings.githubDefaultRepo || '').trim();
          const vaultSession = getVaultSessionStatus(settings, Boolean(rawTok));
          if (vaultSession.revoked && !explicitTok) {
            sendResponse({
              ok: false,
              valid: false,
              authenticated: false,
              vaultSession,
              error: 'Cofre revogado manualmente. Salve ou audite um novo Token PAT para reativar.'
            });
            break;
          }
          if (!rawTok) {
            const anonHealth = await AU_INTEGRATIONS.github.inspectCredentialHealth('', repoInput, settings.githubUsername || '');
            sendResponse(
              Object.assign(
                {
                  ok: true,
                  valid: false,
                  authenticated: false,
                  vaultSession,
                  error: vaultSession.isExpired
                    ? vaultSession.label
                    : 'Nenhum Token PAT ativo na sessão do Cofre (modo público somente leitura).'
                },
                anonHealth
              )
            );
            break;
          }
          const health = await AU_INTEGRATIONS.github.inspectCredentialHealth(
            rawTok,
            repoInput,
            settings.githubUsername || ''
          );
          VAULT_CREDENTIAL_META.lastHealth = health;
          persistVolatileWorkerState();
          sendResponse(Object.assign({ ok: true, vaultSession }, health));
        } catch (err) {
          sendResponse({ ok: false, valid: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GITHUB_REVOKE_VAULT': {
        try {
          SESSION_GLOBAL_GITHUB_TOKEN = '';
          ROOM_GITHUB_TOKENS.clear();
          for (const [rid] of ROOM_VAULT_CAPS.entries()) {
            const room = COLLAB_ROOMS.get(rid);
            if (room) {
              const rotated = {};
              const n = Math.max((room.roles || []).length, (room.agents || []).length, 1);
              for (let i = 1; i <= n; i++) rotated[`ag${i}`] = generateVaultCap();
              ROOM_VAULT_CAPS.set(rid, rotated);
            }
          }
          VAULT_CREDENTIAL_META = {
            storedAt: 0,
            revokedAt: Date.now(),
            lastHealth: null,
            sessionUnavailable: false
          };
          if (typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.clearSessionSecret) {
            await AU_CRED_BROKER.clearSessionSecret('github_pat').catch(() => {});
          }
          if (msg.clearEncryptedDisk && typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.clearEncryptedSecret) {
            await AU_CRED_BROKER.clearEncryptedSecret('github_pat').catch(() => {});
          }
          persistVolatileWorkerState();
          sendResponse({ ok: true, revokedAt: VAULT_CREDENTIAL_META.revokedAt });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GITHUB_CHECK_REPO_ACCESS': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const resolved = await resolveAndPersistGithubInput(
            {
              repo: msg.repo || settings.githubDefaultRepo || '',
              token: msg.token
            },
            settings
          );
          const access = await AU_INTEGRATIONS.github.checkRepoAccess(
            resolved.effectiveToken,
            msg.repo || settings.githubDefaultRepo || '',
            settings.githubUsername || ''
          );
          if (msg.saveAsDefault && access && access.htmlUrl) {
            await AU_STORAGE.saveSettings({
              githubDefaultRepo: access.htmlUrl,
              githubBaseBranch: access.branchFromUrl || access.defaultBranch || 'main'
            });
          }
          sendResponse(Object.assign({ ok: true }, access));
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_SEND_GITHUB_TO_TAB': {
        try {
          await syncOpenArenaTabs();
          const settings = await AU_STORAGE.getSettings();
          const resolved = await resolveAndPersistGithubInput(
            {
              repo: msg.repo || settings.githubDefaultRepo || '',
              token: msg.token,
              baseBranch: msg.baseBranch
            },
            settings
          );
          if (!resolved.spec) {
            throw new Error(
              'Informe o link completo do repositório GitHub (https://github.com/usuario/repositorio) ou usuario/repositorio.'
            );
          }

          const authMode = AU_DEFAULTS.normalizeGithubAuthMode(msg.authMode || settings.githubAuthMode);
          const autoCreatePR =
            msg.autoCreatePR !== undefined ? Boolean(msg.autoCreatePR) : settings.githubAutoCreatePR !== false;
          const targetTabId = Number(msg.tabId || senderTabId || 0);
          const soloBranchSlug = targetTabId
            ? `au/pr-tab${targetTabId}`
            : `au/pr-${AU_COLLAB.generateFourDigitCode()}`;
          const assignedBranch = autoCreatePR ? soloBranchSlug : resolved.effectiveBaseBranch;
          const binId = AU_INTEGRATIONS.generateFilebinId('ghtab');
          const ghCfg = {
            enabled: true,
            repo: resolved.canonicalRepo,
            fullName: resolved.fullName,
            baseBranch: resolved.effectiveBaseBranch,
            authMode,
            branchMode: autoCreatePR ? 'branch_per_agent_pr' : 'single_shared_branch',
            sharedBranch: resolved.effectiveBaseBranch,
            explicitBranch: assignedBranch,
            autoCreatePR,
            soloDirect: true,
            hasVaultCredential: Boolean(resolved.effectiveToken),
            repoSnapshotUrl: '',
            token: ''
          };
          if (
            (authMode === 'extension_proxy_push' || authMode === 'vault_broker_zero_token') &&
            resolved.effectiveToken
          ) {
            ghCfg.repoSnapshotUrl = await stageRepoSnapshotForProxyIfNeeded(
              ghCfg,
              resolved.effectiveToken,
              binId
            );
          }

          const userTask =
            String(msg.userPrompt || '').trim() ||
            `Acesse e clone o repositório ${resolved.spec.webUrl} em /home/user/repo, inspecione a estrutura completa (Code, Issues, Pull requests, Actions) e execute as próximas melhorias abrindo Pull Request direto sem mim no loop.`;
          const ghSnippet = AU_COLLAB.buildGithubInstructions(
            ghCfg,
            { index: 0, agentIndex: 1, shortTitle: 'Agente', isSynthesizer: false },
            'solo'
          );
          const tfSnippet =
            authMode === 'extension_proxy_push'
              ? AU_COLLAB.buildTempFileHubInstructions({
                  enabled: true,
                  filebinId: binId,
                  litterboxExpiry: settings.litterboxExpiry || '24h'
                })
              : '';
          let fullPrompt = [userTask, ghSnippet, tfSnippet].filter(Boolean).join('\n');
          if (typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.scrubSecrets) {
            fullPrompt = AU_CRED_BROKER.scrubSecrets(fullPrompt, resolved.effectiveToken);
          }

          if (targetTabId && TAB_STATES.has(targetTabId)) {
            const prevSt = TAB_STATES.get(targetTabId) || { tabId: targetTabId };
            prevSt.githubActive = true;
            prevSt.githubRepo = resolved.canonicalRepo;
            prevSt.githubBaseBranch = resolved.effectiveBaseBranch;
            prevSt.githubBranch = assignedBranch;
            TAB_STATES.set(targetTabId, prevSt);
            SLOT_INITIAL_PROMPTS.set(targetTabId, fullPrompt);
            persistVolatileWorkerState();
            persistTabStates();

            const tabRes = await sendTabMessageGroupSafe(
              targetTabId,
              {
                type: 'AU_EXECUTE_TAB_COMMAND',
                command: 'send_custom_prompt',
                payload: {
                  prompt: fullPrompt,
                  enableLoop: msg.enableLoop !== false,
                  repo: resolved.canonicalRepo,
                  baseBranch: resolved.effectiveBaseBranch,
                  branch: assignedBranch
                }
              },
              6000
            );
            if (!tabRes || !tabRes.ok) {
              throw new Error(
                'A aba do Arena não respondeu ao envio — recarregue a aba do Arena.ai ou clique sem selecionar aba para abrir uma nova aba Agent.'
              );
            }
            sendResponse({
              ok: true,
              mode: 'sent_to_tab',
              tabId: targetTabId,
              repo: resolved.spec.webUrl,
              baseBranch: resolved.effectiveBaseBranch,
              branch: assignedBranch
            });
          } else {
            const launched = await launchMultiAgentBatch({
              launchMode: 'swarm',
              swarmCount: 1,
              basePrompt: userTask,
              githubEnabled: true,
              githubRepo: resolved.canonicalRepo,
              githubBaseBranch: resolved.effectiveBaseBranch,
              githubAuthMode: authMode,
              autoEnableLoop: msg.enableLoop !== false
            });
            sendResponse(
              Object.assign(
                {
                  ok: true,
                  mode: 'launched_new_tab',
                  repo: resolved.spec.webUrl,
                  baseBranch: resolved.effectiveBaseBranch
                },
                launched
              )
            );
          }
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_SOLO_GITHUB_TURN_COMPLETED': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const activeVaultTok = getActiveVaultToken('', settings);
          const st = senderTabId ? TAB_STATES.get(senderTabId) : null;
          const assistantText = String(msg.assistantText || '');
          const extracted = AU_COLLAB.extractSharedFilesAndGitEvents(assistantText);

          // Scope strictly to tabs that actually activated GitHub (or explicitly emitted [GITHUB_PUSH_PRONTO])!
          const isTabGithubActive = Boolean(
            (st && st.githubActive) ||
            msg.githubActive ||
            extracted.githubPushReadyMessage
          );
          const effectiveRepo = (st && st.githubRepo) || msg.githubRepo || settings.githubDefaultRepo || '';
          const effectiveBase = (st && st.githubBaseBranch) || msg.githubBaseBranch || settings.githubBaseBranch || 'main';
          const effectiveHead = (st && st.githubBranch) || msg.githubBranch || (senderTabId ? `au/pr-tab${senderTabId}` : 'au/pr-solo');

          if (!isTabGithubActive || !activeVaultTok || !effectiveRepo || settings.githubAutoCreatePR === false) {
            sendResponse({ ok: true, skipped: true });
            break;
          }
          const hasReportedPr = (extracted.githubUrls || []).some((u) => u.includes('/pull/'));
          if (hasReportedPr) {
            sendResponse({ ok: true, alreadyReported: true });
            break;
          }
          const turnSig = AU_COLLAB.quickHash(assistantText.slice(-1500));
          if (senderTabId && LAST_TAB_GH_PUSH_SIG.get(senderTabId) === turnSig) {
            sendResponse({ ok: true, deduplicated: true });
            break;
          }
          const latestZip = (extracted.sharedFiles || []).find((f) => /\.zip$/i.test(f.filename || f.url || ''));
          const normalizedSoloAuth = AU_DEFAULTS.normalizeGithubAuthMode(settings.githubAuthMode);
          if (
            extracted.githubPushReadyMessage ||
            ((normalizedSoloAuth === 'extension_proxy_push' ||
              normalizedSoloAuth === 'vault_broker_zero_token') &&
              (latestZip || extracted.isFinalReady))
          ) {
            if (senderTabId) LAST_TAB_GH_PUSH_SIG.set(senderTabId, turnSig);
            const out = await pushArchiveOrWorkspaceToGithub({
              token: activeVaultTok,
              repo: effectiveRepo,
              baseBranch: effectiveBase,
              branch: effectiveHead,
              archiveUrl: latestZip ? latestZip.url : '',
              tabId: senderTabId,
              openPR: true,
              message: extracted.githubPushReadyMessage || 'feat(agent): entrega autônoma via Arena Ultra',
              prTitle: extracted.githubPushReadyMessage || '🚀 Entrega Autônoma (Zero Humano no Loop) — Arena Ultra'
            });
            sendResponse(Object.assign({ ok: true, autoPushed: true }, out));
            break;
          }
          if (senderTabId) LAST_TAB_GH_PUSH_SIG.set(senderTabId, turnSig);
          const autoPr = await AU_INTEGRATIONS.github.ensureAutoPullRequestForBranch(activeVaultTok, {
            repo: effectiveRepo,
            head: effectiveHead,
            base: effectiveBase,
            title: '🚀 Entrega Autônoma (Zero Humano no Loop) — Arena Ultra'
          });
          if (autoPr && autoPr.ok && !autoPr.alreadyExisted) {
            await AU_STORAGE.updateMetrics((m) => {
              m.totalGithubPRsCreated = (m.totalGithubPRsCreated || 0) + 1;
              return m;
            });
          }
          sendResponse(Object.assign({ ok: true }, autoPr || {}));
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GITHUB_LIST_REPOS': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const token = AU_INTEGRATIONS.normalizeGithubToken(msg.token || getActiveVaultToken('', settings));
          const repos = await AU_INTEGRATIONS.github.listRepos(token, msg.perPage || 100);
          sendResponse({ ok: true, repos });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GITHUB_CREATE_REPO': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const token = AU_INTEGRATIONS.normalizeGithubToken(msg.token || getActiveVaultToken('', settings));
          const repo = await AU_INTEGRATIONS.github.createRepo(token, msg.options || {});
          await AU_STORAGE.saveSettings({
            githubDefaultRepo: repo.htmlUrl || repo.fullName,
            githubBaseBranch: repo.defaultBranch || 'main'
          });
          sendResponse({ ok: true, repo });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GITHUB_GET_REPO_OVERVIEW': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const token = AU_INTEGRATIONS.normalizeGithubToken(msg.token || getActiveVaultToken('', settings));
          const repoName = String(msg.repo || settings.githubDefaultRepo || '').trim();
          const overview = await AU_INTEGRATIONS.github.getRepoOverview(
            token,
            repoName,
            settings.githubUsername || ''
          );
          sendResponse({ ok: true, overview });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GITHUB_PUSH_BUNDLE': {
        try {
          await ensureCollabRoomsLoaded();
          const targetTabId = msg.tabId || senderTabId || null;
          const settings = await AU_STORAGE.getSettings();
          const roomTok = msg.roomId ? getActiveVaultToken(String(msg.roomId), settings) : getActiveVaultToken('', settings);
          const out = await pushArchiveOrWorkspaceToGithub({
            token: msg.token || roomTok,
            repo: msg.repo,
            branch: msg.branch,
            baseBranch: msg.baseBranch,
            message: msg.message,
            archiveUrl: msg.archiveUrl || '',
            filename: msg.filename || '',
            tabId: targetTabId,
            files: Array.isArray(msg.files) ? msg.files : undefined,
            openPR: Boolean(msg.openPR),
            prTitle: msg.prTitle,
            prBody: msg.prBody
          });

          if (msg.roomId && COLLAB_ROOMS.has(String(msg.roomId))) {
            const room = COLLAB_ROOMS.get(String(msg.roomId));
            if (room.githubConfig) {
              room.githubConfig.commitsPushed = Number(room.githubConfig.commitsPushed || 0) + 1;
              room.githubConfig.lastCommitUrl = out.commitUrl || '';
              if (out.pullRequest && out.pullRequest.htmlUrl) {
                room.githubConfig.pullRequestUrl = out.pullRequest.htmlUrl;
              }
            }
            await appendRoomMessage(
              room,
              {
                senderType: 'system',
                senderName: 'GitHub',
                text:
                  `🐙 Push concluído em ${out.repo}@${out.branch} (${out.filesCount} arquivos • commit ${out.shortSha})` +
                  (out.pullRequest ? ` • PR #${out.pullRequest.number}: ${out.pullRequest.htmlUrl}` : '')
              },
              true
            );
            persistCollabRooms();
          }

          await AU_STORAGE.appendSessionLog({
            tabTitle: `GitHub Push → ${out.repo}@${out.branch}`,
            url: out.commitUrl,
            eventType: 'github_push',
            loopsCount: out.filesCount,
            details: `Commit ${out.shortSha} (${out.filesCount} arquivos)${out.pullRequest ? ' • PR #' + out.pullRequest.number : ''}`
          });

          sendResponse(out);
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GITHUB_CREATE_PR': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const token = String(msg.token || getActiveVaultToken('', settings) || '').trim();
          const pr = await AU_INTEGRATIONS.github.createPullRequest(token, msg.options || {});
          if (pr && !pr.alreadyExisted) {
            await AU_STORAGE.updateMetrics((m) => {
              m.totalGithubPRsCreated = (m.totalGithubPRsCreated || 0) + 1;
              return m;
            });
          }
          sendResponse(pr);
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_TEMPFILE_UPLOAD': {
        try {
          await ensureCollabRoomsLoaded();
          const settings = await AU_STORAGE.getSettings();
          const bytes = AU_INTEGRATIONS.base64ToUint8(msg.base64Data || '');
          const room = msg.roomId ? COLLAB_ROOMS.get(String(msg.roomId)) : null;
          const binId = msg.binId || (room ? room.filebinId : '') || AU_INTEGRATIONS.generateFilebinId('upload');

          const uploaded = await AU_INTEGRATIONS.uploadWithFallback(bytes, msg.filename || 'arquivo.bin', {
            primaryProvider: msg.primaryProvider || settings.tempFilePrimaryProvider || 'filebin',
            autoFallback: msg.autoFallback !== undefined ? Boolean(msg.autoFallback) : Boolean(settings.tempFileAutoFallback),
            expiry: msg.expiry || settings.litterboxExpiry || '24h',
            mimeType: msg.mimeType || 'application/octet-stream',
            binId
          });

          if (room) {
            registerSharedFileInRoom(room, {
              filename: uploaded.filename,
              provider: uploaded.providerLabel || uploaded.provider,
              sizeBytes: uploaded.sizeBytes,
              url: uploaded.url,
              uploadedBy: 'Coordenador (Você)'
            });
            await appendRoomMessage(
              room,
              {
                senderType: 'user',
                senderName: 'Coordenador (Você)',
                senderRole: 'Arquivo Compartilhado',
                text: `📦 Compartilhei um arquivo para toda a equipe usar:\n[ARQUIVO_COMPARTILHADO] ${uploaded.filename} | ${uploaded.providerLabel} | ${uploaded.url} [/ARQUIVO_COMPARTILHADO]\nBaixem com: curl -fsSL -H "Cookie: verified=2024-05-24" "${uploaded.url}" -o "${uploaded.filename}"`
              },
              true
            );
            for (const ag of room.agents || []) {
              ag.waitingSince = 0;
            }
          } else {
            await AU_STORAGE.updateMetrics((m) => {
              m.totalTempFilesShared = (m.totalTempFilesShared || 0) + 1;
              return m;
            });
          }

          sendResponse(Object.assign({ ok: true }, uploaded));
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_TEMPFILE_SYNC_ROOM_BIN': {
        await ensureCollabRoomsLoaded();
        const room = msg.roomId ? COLLAB_ROOMS.get(String(msg.roomId)) : null;
        if (room) {
          room.lastFilebinSyncAt = 0;
          const added = await syncRoomFilebinBucket(room);
          sendResponse({ ok: true, added, room: serializeRoomForClient(room) });
        } else if (msg.binId) {
          const files = await AU_INTEGRATIONS.listFilebinFiles(String(msg.binId));
          sendResponse({ ok: true, files });
        } else {
          sendResponse({ ok: false, error: 'Informe a sala ou binId.' });
        }
        break;
      }

      case 'AU_LAUNCH_MULTI_AGENT': {
        try {
          const result = await launchMultiAgentBatch(msg.config || {});
          sendResponse(Object.assign({ ok: true }, result));
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_CONTROL_TAB': {
        const tabId = Number(msg.tabId);
        if (!tabId) {
          sendResponse({ ok: false, error: 'tabId inválido' });
          return;
        }
        if (msg.command === 'focus') {
          try {
            const tab = await chrome.tabs.update(tabId, { active: true });
            if (
              tab &&
              typeof tab.groupId === 'number' &&
              tab.groupId >= 0 &&
              chrome.tabGroups &&
              typeof chrome.tabGroups.update === 'function'
            ) {
              await chrome.tabGroups.update(tab.groupId, { collapsed: false }).catch(() => {});
            }
            if (tab && tab.windowId) {
              await chrome.windows.update(tab.windowId, { focused: true });
            }
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          return;
        }
        if (msg.command === 'download_workspace') {
          try {
            const tabRes = await sendTabMessageGroupSafe(
              tabId,
              {
                type: 'AU_EXECUTE_TAB_COMMAND',
                command: 'download_workspace',
                payload: { returnBytes: Boolean(msg.returnBytes) }
              },
              26000
            );
            if (tabRes && tabRes.ok) {
              sendResponse(tabRes);
              return;
            }
            sendResponse({
              ok: false,
              error:
                (tabRes && tabRes.error) ||
                'Esta sessão ainda não possui arquivos salvos no Workspace (/home/user).'
            });
            return;
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
            return;
          }
        }
        const res = await sendTabMessageGroupSafe(
          tabId,
          {
            type: 'AU_EXECUTE_TAB_COMMAND',
            command: msg.command,
            payload: msg.payload || {}
          },
          2200
        );
        if (res) {
          sendResponse(res);
        } else {
          sendResponse({ ok: false, error: 'Aba ainda carregando ou desconectada. Atualize a aba do Arena.ai.' });
        }
        break;
      }

      case 'AU_GLOBAL_TAB_ACTION': {
        await syncOpenArenaTabs();
        const command = msg.command; // 'pause_all' | 'resume_all' | 'broadcast_prompt' | 'apply_settings'
        let affected = 0;
        for (const [tabId] of TAB_STATES.entries()) {
          const okRes = await sendTabMessageGroupSafe(
            tabId,
            {
              type: 'AU_EXECUTE_TAB_COMMAND',
              command,
              payload: msg.payload || {}
            },
            2000
          );
          if (okRes) affected += 1;
        }
        await refreshExtensionBadge();
        ensureAntiThrottleHeartbeat();
        sendResponse({ ok: true, affected });
        break;
      }

      case 'AU_GROUP_ARENA_TABS': {
        await syncOpenArenaTabs();
        const settings = await AU_STORAGE.getSettings();
        const ids = Array.from(TAB_STATES.keys());
        const groupId = await groupTabsSafely(
          ids,
          settings.launcherTabGroupName || 'Arena Ultra • Agents',
          settings.launcherTabGroupColor || 'green'
        );
        sendResponse({ ok: groupId !== null, count: ids.length });
        break;
      }

      case 'AU_SPLIT_ARENA_WINDOWS': {
        const res = await splitArenaTabsIntoGrid();
        sendResponse(res);
        break;
      }

      case 'AU_OPEN_LIVECHAT': {
        const roomParam = msg.roomId ? `?room=${encodeURIComponent(String(msg.roomId))}` : '';
        const liveUrlBase = chrome.runtime.getURL('livechat/livechat.html');
        const liveUrl = liveUrlBase + roomParam;
        const existing = await chrome.tabs.query({ url: liveUrlBase + '*' });
        if (existing && existing.length > 0) {
          const targetTab = existing[0];
          await chrome.tabs.update(targetTab.id, {
            active: true,
            ...(msg.roomId ? { url: liveUrl } : {})
          });
          if (
            typeof targetTab.groupId === 'number' &&
            targetTab.groupId >= 0 &&
            chrome.tabGroups &&
            typeof chrome.tabGroups.update === 'function'
          ) {
            await chrome.tabGroups.update(targetTab.groupId, { collapsed: false }).catch(() => {});
          }
          if (targetTab.windowId) {
            await chrome.windows.update(targetTab.windowId, { focused: true });
          }
        } else {
          await chrome.tabs.create({ url: liveUrl, active: true });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_OPEN_DASHBOARD': {
        const dashUrl = chrome.runtime.getURL('dashboard/dashboard.html') + (msg.section ? '#' + msg.section : '');
        const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('dashboard/dashboard.html') + '*' });
        if (existing && existing.length > 0) {
          await chrome.tabs.update(existing[0].id, { active: true, url: dashUrl });
          if (existing[0].windowId) {
            await chrome.windows.update(existing[0].windowId, { focused: true });
          }
        } else {
          await chrome.tabs.create({ url: dashUrl, active: true });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_TEST_WEBHOOK': {
        try {
          const out = await sendWebhookNotification(msg.webhookUrl, {
            title: '✅ Teste de Conexão — Arena Ultra',
            message: 'Seu Webhook está configurado e pronto para avisar quando seus Agents pararem por falta de tokens!',
            tabTitle: 'Painel de Controle Arena Ultra',
            loopsCount: 15,
            statusLabel: 'Conectado com Sucesso',
            color: 0x10b981
          });
          sendResponse(out);
        } catch (e) {
          sendResponse({ ok: false, reason: e.message || String(e) });
        }
        break;
      }

      case 'AU_COLLAB_CONFIRM_CLEAN_ADMISSION': {
        await ensureCollabRoomsLoaded();
        const p = msg.payload || {};
        const st = senderTabId ? TAB_STATES.get(senderTabId) : null;
        // ARENA-18: Enforce SW room authority & bindingEpoch
        const authRoomId = st && st.collabRoomId ? String(st.collabRoomId) : '';
        const room = authRoomId && (!p.roomId || String(p.roomId) === authRoomId) ? COLLAB_ROOMS.get(authRoomId) : null;
        if (room && senderTabId) {
          const ag = (room.agents || []).find((a) => a.tabId === senderTabId);
          if (
            ag &&
            (!p.bindingEpoch || !ag.bindingEpoch || Number(p.bindingEpoch) === Number(ag.bindingEpoch)) &&
            !ag.admittedToTeam &&
            ag.screeningStatus !== 'refused_stopped'
          ) {
            ag.admittedToTeam = true;
            ag.screeningStatus = 'admitted';
            await appendRoomMessage(
              room,
              {
                senderType: 'system',
                senderName: 'Time Anti-Thinking',
                text: `✅ ${ag.name} (${ag.roleTitle}) confirmado sem Thinking em tempo real${ag.refusedCount > 0 ? ` (após recusar ${ag.refusedCount} modelo(s))` : ''} e admitido ao Time!`
              },
              false
            );
            persistCollabRooms();
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_COLLAB_LIVE_PROSE_MSG': {
        await ensureCollabRoomsLoaded();
        const p = msg.payload || {};
        const st = senderTabId ? TAB_STATES.get(senderTabId) : null;
        // ARENA-18: Enforce SW room authority & bindingEpoch
        const authRoomId = st && st.collabRoomId ? String(st.collabRoomId) : '';
        if (p.roomId && authRoomId && String(p.roomId) !== authRoomId) {
          const leakTarget = COLLAB_ROOMS.get(String(p.roomId));
          if (leakTarget) {
            leakTarget.quarantinedCrossRoomCount = Number(leakTarget.quarantinedCrossRoomCount || 0) + 1;
            persistCollabRooms();
          }
          sendResponse({ ok: false, rejectedCrossRoom: true });
          break;
        }
        const room = authRoomId ? COLLAB_ROOMS.get(authRoomId) : null;
        const rawTxt = String(p.text || '').trim();
        const txt =
          typeof AU_ARENA_ADAPTER !== 'undefined' && AU_ARENA_ADAPTER.scrubSerializedReasoning
            ? AU_ARENA_ADAPTER.scrubSerializedReasoning(rawTxt).text.trim()
            : rawTxt;
        if (room && senderTabId && txt) {
          const ag = (room.agents || []).find((a) => a.tabId === senderTabId);
          if (
            ag &&
            (!p.bindingEpoch || !ag.bindingEpoch || Number(p.bindingEpoch) === Number(ag.bindingEpoch)) &&
            (ag.admittedToTeam || room.refuseThinkingModels === false) &&
            ag.lastLiveProseText !== txt
          ) {
            ag.lastLiveProseText = txt;
            const settings = await AU_STORAGE.getSettings();
            if (typeof AU_COLLAB !== 'undefined' && AU_COLLAB.extractBoardUpdatesFromText) {
              ensureRoomBoardInitialized(room);
              const slotKey = `ag${Number(ag.index || 0) + 1}`;
              const bUpds = AU_COLLAB.extractBoardUpdatesFromText(txt, slotKey, ag.name);
              for (const u of bUpds.assignments || []) {
                AU_COLLAB.upsertBoardAssignment(
                  room.sharedBoard,
                  u.slotKey || slotKey,
                  { status: u.status, files: u.files, branch: u.branch, notes: u.notes },
                  ag.name
                );
              }
              for (const c of bUpds.contracts || []) {
                AU_COLLAB.upsertBoardContract(
                  room.sharedBoard,
                  c.key,
                  { spec: c.spec, status: c.status, owner: ag.name },
                  ag.name
                );
              }
            }
            const cleanLiveTxt =
              typeof AU_COLLAB.sanitizeConciseTeamMessage === 'function'
                ? AU_COLLAB.sanitizeConciseTeamMessage(txt, 900)
                : txt.slice(0, 900);
            if (!cleanLiveTxt) {
              sendResponse({ ok: true });
              break;
            }
            const effectiveTok = getActiveVaultToken(room.roomId, settings);
            await appendRoomMessage(
              room,
              {
                senderType: 'agent',
                senderName: `⚡ ${ag.name}`,
                senderRole: ag.roleTitle,
                tabId: senderTabId,
                text: cleanLiveTxt
              },
              true,
              effectiveTok
            );
            pushRealtimeMessageToBin(room, {
              senderName: ag.name,
              senderRole: ag.roleTitle,
              tag: `ag${Number(ag.index || 0) + 1}`,
              text: cleanLiveTxt
            }).catch(() => {});
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_REMEMBER_INITIAL_PROMPT': {
        if (senderTabId && msg.prompt) {
          SLOT_INITIAL_PROMPTS.set(senderTabId, String(msg.prompt));
          persistVolatileWorkerState();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AU_MODEL_THINKING_REFUSED': {
        const targetId = msg.tabId || senderTabId;
        if (!targetId) {
          sendResponse({ ok: false, error: 'Aba não identificada.' });
          return;
        }
        try {
          const out = await handleThinkingModelRefused(targetId, msg.payload || {});
          sendResponse(out);
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      // =====================================================================
      // v4.0.0 AUTONOMY GOVERNANCE, VAULT, DIFF, SEARCH, SCHEDULER & PLUGINS
      // =====================================================================
      case 'AU_EMERGENCY_STOP_ALL': {
        // ARENA-11: Global 1-click "PARAR TUDO" Kill Switch (< 2s SLA)
        const startedAt = Date.now();
        await ensureCollabRoomsLoaded();
        PENDING_JOBS.clear();
        persistVolatileWorkerState();

        let pausedRooms = 0;
        for (const r of COLLAB_ROOMS.values()) {
          if (r && (r.status === 'active' || r.status === 'needs_human')) {
            r.status = 'paused';
            r.updatedAt = startedAt;
            await appendRoomMessage(
              r,
              {
                senderType: 'system',
                senderName: 'PARAR TUDO',
                text: '🛑 [PARAR TUDO ACIONADO] Todas as salas e abas em Autopilot foram pausadas imediatamente pelo Coordenador.'
              },
              false
            );
            pausedRooms += 1;
          }
        }
        if (pausedRooms > 0) persistCollabRooms(true);

        const targetTabIds = Array.from(TAB_STATES.keys());
        for (const tid of targetTabIds) {
          const st = TAB_STATES.get(tid);
          if (st) {
            st.autoContinueEnabled = false;
            st.status = 'idle';
            st.stopReason = 'PARAR TUDO acionado pelo usuário';
            TAB_STATES.set(tid, st);
          }
        }
        persistTabStates(true);

        await Promise.allSettled(
          targetTabIds.map((tid) =>
            chrome.tabs
              .sendMessage(tid, {
                type: 'AU_EXECUTE_TAB_COMMAND',
                command: 'emergency_stop',
                payload: { reason: 'PARAR TUDO acionado' }
              })
              .catch(() => {})
          )
        );

        ensureAntiThrottleHeartbeat();
        await refreshExtensionBadge();
        await AU_STORAGE.appendSessionLog({
          tabTitle: 'Kill Switch Global (PARAR TUDO)',
          url: 'chrome-extension://arena-ultra',
          eventType: 'emergency_stop',
          loopsCount: targetTabIds.length,
          details: `${targetTabIds.length} aba(s) e ${pausedRooms} sala(s) paradas em ${Date.now() - startedAt}ms`
        });
        sendResponse({
          ok: true,
          stoppedTabs: targetTabIds.length,
          pausedRooms,
          elapsedMs: Date.now() - startedAt
        });
        break;
      }

      case 'AU_AUTHORIZE_TASK_POLICY': {
        await ensureCollabRoomsLoaded();
        const policyPatch = msg.policy && typeof msg.policy === 'object' ? msg.policy : {};
        if (msg.permanentAuto !== undefined) {
          await AU_STORAGE.saveSettings({
            taskAutoAuthorizePermanent: Boolean(msg.permanentAuto)
          });
        }
        let updatedRoom = null;
        if (msg.roomId && COLLAB_ROOMS.has(String(msg.roomId))) {
          const room = COLLAB_ROOMS.get(String(msg.roomId));
          room.taskPolicy = Object.assign({}, room.taskPolicy || {}, policyPatch, {
            authorizedAt: Date.now()
          });
          if (room.status === 'needs_human' || room.status === 'paused') {
            room.status = 'active';
            room.needsHumanReason = '';
          }
          persistCollabRooms(true);
          updatedRoom = serializeRoomForClient(room);
        }
        await refreshExtensionBadge();
        sendResponse({ ok: true, room: updatedRoom });
        break;
      }

      case 'AU_VAULT_SET_SECRET': {
        try {
          if (msg.githubToken !== undefined) {
            await setGlobalVaultToken(msg.githubToken);
          }
          if (msg.webhookUrl !== undefined) {
            await setGlobalWebhookSecret(msg.webhookUrl);
          }
          const settings = await AU_STORAGE.getSettings();
          const hasTok = Boolean(getActiveVaultToken('', settings));
          const hasEnc =
            typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.hasEncryptedVaultOnDisk
              ? await AU_CRED_BROKER.hasEncryptedVaultOnDisk()
              : false;
          sendResponse({
            ok: true,
            hasToken: hasTok,
            hasWebhookUrl: Boolean(SESSION_WEBHOOK_URL),
            hasEncryptedDiskVault: hasEnc,
            vaultSession: getVaultSessionStatus(settings, hasTok)
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_VAULT_GET_STATUS': {
        try {
          const settings = await AU_STORAGE.getSettings();
          const hasTok = Boolean(getActiveVaultToken('', settings));
          const hasEnc =
            typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.hasEncryptedVaultOnDisk
              ? await AU_CRED_BROKER.hasEncryptedVaultOnDisk()
              : false;
          sendResponse({
            ok: true,
            hasToken: hasTok,
            hasWebhookUrl: Boolean(SESSION_WEBHOOK_URL),
            hasEncryptedDiskVault: hasEnc,
            sessionUnavailable: Boolean(VAULT_CREDENTIAL_META.sessionUnavailable),
            vaultSession: getVaultSessionStatus(settings, hasTok)
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_VAULT_SAVE_ENCRYPTED': {
        try {
          const passphrase = String(msg.passphrase || '');
          const tok = AU_INTEGRATIONS.normalizeGithubToken(
            msg.githubToken !== undefined ? msg.githubToken : SESSION_GLOBAL_GITHUB_TOKEN
          );
          const wh = msg.webhookUrl !== undefined ? String(msg.webhookUrl || '').trim() : SESSION_WEBHOOK_URL;
          const saved = await AU_CRED_BROKER.saveEncryptedVaultToDisk(
            { githubToken: tok, webhookUrl: wh },
            passphrase
          );
          if (tok) await setGlobalVaultToken(tok);
          if (wh) await setGlobalWebhookSecret(wh);
          sendResponse(Object.assign({ ok: true, hasEncryptedDiskVault: true }, saved));
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_VAULT_UNLOCK_ENCRYPTED': {
        try {
          const unlocked = await AU_CRED_BROKER.unlockEncryptedVaultFromDisk(String(msg.passphrase || ''));
          const sess = await AU_CRED_BROKER.getSessionSecrets();
          if (sess.githubToken) await setGlobalVaultToken(sess.githubToken);
          if (sess.webhookUrl) await setGlobalWebhookSecret(sess.webhookUrl);
          const settings = await AU_STORAGE.getSettings();
          sendResponse(
            Object.assign(
              {
                ok: true,
                vaultSession: getVaultSessionStatus(settings, Boolean(sess.githubToken))
              },
              unlocked
            )
          );
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_SECURITY_AUDIT_LOG_GET': {
        try {
          const logs =
            typeof AU_CRED_BROKER !== 'undefined' && AU_CRED_BROKER.getSecurityAuditLog
              ? await AU_CRED_BROKER.getSecurityAuditLog()
              : [];
          sendResponse({ ok: true, logs });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err), logs: [] });
        }
        break;
      }

      case 'AU_DIAGNOSTICS_GET': {
        const diags = await AU_STORAGE.getDiagnostics();
        sendResponse({ ok: true, diagnostics: diags });
        break;
      }

      case 'AU_DIAGNOSTICS_EXPORT': {
        await ensureCollabRoomsLoaded();
        const report = await AU_STORAGE.exportSanitizedDiagnosticReport({
          openArenaTabsCount: TAB_STATES.size,
          activeCollabRoomsCount: COLLAB_ROOMS.size,
          pendingJobsCount: PENDING_JOBS.size,
          volatileSessionDegraded: Boolean(VAULT_CREDENTIAL_META.sessionUnavailable)
        });
        sendResponse({ ok: true, report });
        break;
      }

      case 'AU_COMPUTE_ROOM_DIFF': {
        // PROD-01: Unified Multi-Agent Diff & File Conflict Matrix across Room Agents
        try {
          await ensureCollabRoomsLoaded();
          const room = COLLAB_ROOMS.get(String(msg.roomId || ''));
          if (!room) throw new Error('Sala TempChat não encontrada.');

          const agentSnapshots = [];
          for (const ag of room.agents || []) {
            if (!ag || ag.closed || !ag.tabId) continue;
            const wsRes = await sendTabMessageGroupSafe(
              ag.tabId,
              {
                type: 'AU_EXECUTE_TAB_COMMAND',
                command: 'export_workspace_files',
                payload: { preferRepoSubdir: true }
              },
              14000
            );
            const filesMap = {};
            if (wsRes && wsRes.ok && Array.isArray(wsRes.files)) {
              const dec = new TextDecoder('utf-8', { fatal: false });
              for (const f of wsRes.files) {
                if (!f || !f.path) continue;
                if (typeof f.content === 'string') {
                  filesMap[f.path] = f.content;
                } else if (typeof f.base64 === 'string' && f.base64.length < 400000) {
                  try {
                    filesMap[f.path] = dec.decode(AU_INTEGRATIONS.base64ToUint8(f.base64));
                  } catch (_) {}
                }
              }
            }
            agentSnapshots.push({
              agentId: `ag${Number(ag.index || 0) + 1}`,
              agentName: ag.name,
              roleTitle: ag.roleTitle,
              files: filesMap
            });
          }

          const diffReport = AU_DIFF.computeMultiAgentRoomDiff(agentSnapshots, msg.baseFiles || {});
          sendResponse({ ok: true, roomId: room.roomId, diff: diffReport });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_GLOBAL_SEARCH': {
        // PROD-02: Unified Search across Saved Chats, Prompts, Macros, and Active Rooms
        try {
          await ensureCollabRoomsLoaded();
          const q = String(msg.query || '').trim();
          const baseResults = await AU_STORAGE.searchGlobalIndex(q, msg.options || {});
          const ql = q.toLowerCase();
          const roomHits = [];
          if (ql) {
            for (const r of COLLAB_ROOMS.values()) {
              for (const m of r.messages || []) {
                const hay = `${m.senderName || ''} ${m.text || ''}`.toLowerCase();
                if (hay.includes(ql)) {
                  roomHits.push({
                    type: 'room_message',
                    id: m.id,
                    roomId: r.roomId,
                    title: `Sala #${r.roomId} • ${m.senderName}`,
                    snippet: String(m.text || '').slice(0, 180),
                    timestamp: m.timestamp
                  });
                  if (roomHits.length >= 25) break;
                }
              }
            }
          }
          sendResponse({
            ok: true,
            results: (Array.isArray(baseResults) ? baseResults : []).concat(roomHits)
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err), results: [] });
        }
        break;
      }

      case 'AU_SCHEDULER_LIST': {
        const schedules = await AU_SCHEDULER.getSchedules();
        sendResponse({ ok: true, schedules });
        break;
      }

      case 'AU_SCHEDULER_UPSERT': {
        try {
          const item = await AU_SCHEDULER.upsertSchedule(msg.schedule || {});
          const schedules = await AU_SCHEDULER.getSchedules();
          sendResponse({ ok: true, item, schedules });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_SCHEDULER_DELETE': {
        await AU_SCHEDULER.deleteSchedule(msg.id);
        const schedules = await AU_SCHEDULER.getSchedules();
        sendResponse({ ok: true, schedules });
        break;
      }

      case 'AU_PROMOTE_SINGLE_TO_ROOM': {
        // PROD-12: 1-click Promotion of a Solo Agent Tab to a Multi-Agent TempChat Room
        try {
          await syncOpenArenaTabs();
          const tabId = Number(msg.tabId || senderTabId || 0);
          if (!tabId || !TAB_STATES.has(tabId)) {
            throw new Error('Selecione uma aba ativa do Arena.ai para promover a Sala Multi-Agent.');
          }
          const totalAgents = Math.min(60, Math.max(2, Number(msg.agentCount || 3)));
          const baseTask = String(msg.baseTask || SLOT_INITIAL_PROMPTS.get(tabId) || 'Colaboração promovida de sessão solo').trim();
          const room = await createCollabRoomFromOpenTabs({
            tabIds: [tabId],
            baseTask,
            profile: msg.profile || 'specialists',
            stopMode: msg.stopMode || 'smart_consensus',
            githubEnabled: Boolean(msg.githubEnabled || (TAB_STATES.get(tabId) && TAB_STATES.get(tabId).githubActive)),
            githubRepo: msg.githubRepo || (TAB_STATES.get(tabId) && TAB_STATES.get(tabId).githubRepo) || ''
          });
          const rawRoom = COLLAB_ROOMS.get(room.roomId);
          if (rawRoom && totalAgents > 1) {
            rawRoom.roles = AU_COLLAB.buildTeamRoles(totalAgents, rawRoom.profile);
            rawRoom.sharedBoard = AU_COLLAB.createInitialSharedBoard(
              rawRoom.roles,
              rawRoom.roomId,
              rawRoom.githubConfig || null
            );
            if (rawRoom.agents[0] && rawRoom.roles[0]) {
              rawRoom.agents[0].name = rawRoom.roles[0].shortTitle;
              rawRoom.agents[0].roleTitle = rawRoom.roles[0].roleTitle;
              rawRoom.agents[0].roleDesc = rawRoom.roles[0].roleDesc;
              rawRoom.agents[0].isSynthesizer = Boolean(rawRoom.roles[0].isSynthesizer);
            }
            const settings = await AU_STORAGE.getSettings();
            const vaultCaps = ensureRoomVaultCaps(rawRoom);
            for (let idx = 1; idx < totalAgents; idx++) {
              const role = rawRoom.roles[idx];
              const slotKey = `ag${idx + 1}`;
              const peerGh =
                rawRoom.githubConfig && rawRoom.githubConfig.enabled
                  ? Object.assign({}, rawRoom.githubConfig, {
                      filebinId: rawRoom.filebinId,
                      agentVaultCap: vaultCaps[slotKey] || '',
                      hasVaultCredential: Boolean(getActiveVaultToken(rawRoom.roomId, settings)),
                      token: ''
                    })
                  : null;
              const peerPrompt = AU_COLLAB.buildInitialAgentPrompt({
                roomId: rawRoom.roomId,
                roomHmacKey: rawRoom.roomHmacKey || '',
                basePrompt: baseTask,
                agentKitEnabled: rawRoom.agentKitEnabled === true,
                harnessEnabled: settings.harnessEnabled !== false,
                sessionTimerMinutes: settings.sessionMinTimerMinutes,
                agentRole: role,
                teamRoles: rawRoom.roles,
                profile: rawRoom.profile,
                stopMode: rawRoom.stopMode,
                sharedBoard: rawRoom.sharedBoard,
                integrationStatus: AU_COLLAB.computeRoomIntegrationStatus(rawRoom),
                tempFileConfig: { enabled: true, filebinId: rawRoom.filebinId, litterboxExpiry: '24h' },
                githubConfig: peerGh
              });
              const peerTab = await chrome.tabs.create({ url: 'https://arena.ai/agent', active: false });
              const epoch = nextTabBindingEpoch(peerTab.id);
              rawRoom.agents.push({
                tabId: peerTab.id,
                bindingEpoch: epoch,
                index: idx,
                name: role.shortTitle,
                roleTitle: role.roleTitle,
                roleDesc: role.roleDesc,
                isSynthesizer: role.isSynthesizer,
                githubAccessLevel: role.githubAccessLevel || 'auto_role',
                admittedToTeam: !rawRoom.refuseThinkingModels,
                screeningStatus: rawRoom.refuseThinkingModels ? 'screening' : 'admitted',
                refusedCount: 0,
                lastScreeningAt: Date.now(),
                lastSeenSeq: rawRoom.seq,
                lastTurnHash: '',
                waitingSince: 0,
                turnsCount: 0,
                closed: false
              });
              PENDING_JOBS.set(peerTab.id, {
                jobId: `promote_${rawRoom.roomId}_${idx}_${Date.now()}`,
                initialPrompt: peerPrompt,
                autoEnableLoop: true,
                strategy: settings.autoContinueStrategy || 'hybrid',
                fixedPrompt: settings.fixedContinuePrompt,
                queue: [],
                collabRoomId: rawRoom.roomId,
                collabAgentName: role.shortTitle,
                bindingEpoch: epoch,
                githubActive: Boolean(peerGh),
                githubRepo: peerGh ? peerGh.repo : '',
                githubBaseBranch: peerGh ? peerGh.baseBranch : '',
                githubBranch: peerGh ? AU_COLLAB.computeAgentBranchName(rawRoom.roomId, role, peerGh) : '',
                refuseThinkingModels: rawRoom.refuseThinkingModels,
                rerollAttempt: 0,
                createdAt: Date.now(),
                lastPushAt: 0
              });
              TAB_STATES.set(peerTab.id, {
                tabId: peerTab.id,
                windowId: peerTab.windowId,
                url: 'https://arena.ai/agent',
                title: `${role.shortTitle} • TempChat #${rawRoom.roomId}`,
                mode: 'agent',
                autoContinueEnabled: true,
                strategy: settings.autoContinueStrategy || 'hybrid',
                status: 'queued',
                loopsCount: 0,
                queueLength: 0,
                estimatedTokens: AU_STORAGE.estimateTokens(peerPrompt),
                lastActivityAt: Date.now(),
                stopReason: '',
                collabRoomId: rawRoom.roomId,
                collabAgentName: role.shortTitle,
                bindingEpoch: epoch,
                githubActive: Boolean(peerGh),
                githubRepo: peerGh ? peerGh.repo : '',
                githubBaseBranch: peerGh ? peerGh.baseBranch : ''
              });
            }
            persistVolatileWorkerState();
            persistCollabRooms(true);
            persistTabStates(true);
            ensureAntiThrottleHeartbeat();
          }
          sendResponse({ ok: true, room: serializeRoomForClient(rawRoom || room) });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'AU_QUALITY_GATE_CHECK': {
        const res = runPrePrQualityGate(Array.isArray(msg.files) ? msg.files : []);
        sendResponse(Object.assign({ ok: true }, res));
        break;
      }

      case 'AU_DEADLOCK_DIAGNOSE': {
        // ENG-11: Observability & Circular Wait Deadlock Detector
        await ensureCollabRoomsLoaded();
        const now = Date.now();
        const reports = [];
        for (const r of COLLAB_ROOMS.values()) {
          if (!r || r.status !== 'active') continue;
          const openAgents = (r.agents || []).filter((a) => a && !a.closed && a.screeningStatus !== 'refused_stopped');
          const waitingAgents = openAgents.filter((a) => a.waitingSince && now - a.waitingSince > 25000);
          const allWaiting = openAgents.length > 1 && waitingAgents.length === openAgents.length;
          if (allWaiting && msg.autoResolve) {
            for (const a of openAgents) a.waitingSince = 0;
            ensureHealthySynthesizerLeader(r);
            persistCollabRooms();
          }
          reports.push({
            roomId: r.roomId,
            leaderEpoch: r.leaderEpoch || 1,
            openAgentsCount: openAgents.length,
            waitingAgentsCount: waitingAgents.length,
            deadlockDetected: allWaiting,
            resolved: Boolean(allWaiting && msg.autoResolve)
          });
        }
        sendResponse({ ok: true, reports });
        break;
      }

      case 'AU_PLUGINS_LIST': {
        const plugins = await AU_PLUGINS.getPlugins();
        sendResponse({ ok: true, plugins });
        break;
      }

      case 'AU_PLUGINS_UPSERT': {
        const plugin = await AU_PLUGINS.upsertPlugin(msg.plugin || {});
        const plugins = await AU_PLUGINS.getPlugins();
        sendResponse({ ok: true, plugin, plugins });
        break;
      }

      case 'AU_PLUGINS_DELETE': {
        await AU_PLUGINS.deletePlugin(msg.id);
        const plugins = await AU_PLUGINS.getPlugins();
        sendResponse({ ok: true, plugins });
        break;
      }

      case 'AU_CODEBASE_MEMORY_GET': {
        if (msg.repo) {
          const memory = await AU_STORAGE.getRepoMemory(msg.repo);
          sendResponse({ ok: true, memory });
        } else {
          const memories = await AU_STORAGE.listRepoMemories();
          sendResponse({ ok: true, memories });
        }
        break;
      }

      case 'AU_CODEBASE_MEMORY_SAVE': {
        const saved = await AU_STORAGE.saveRepoMemory(msg.repo, msg.patch || {});
        sendResponse({ ok: true, memory: saved });
        break;
      }

      case 'AU_PRESETS_LIST': {
        const presets = await AU_STORAGE.getRoomPresets();
        sendResponse({ ok: true, presets });
        break;
      }

      case 'AU_PRESETS_UPSERT': {
        const preset = await AU_STORAGE.upsertRoomPreset(msg.preset || {});
        const presets = await AU_STORAGE.getRoomPresets();
        sendResponse({ ok: true, preset, presets });
        break;
      }

      case 'AU_PRESETS_DELETE': {
        await AU_STORAGE.deleteRoomPreset(msg.id);
        const presets = await AU_STORAGE.getRoomPresets();
        sendResponse({ ok: true, presets });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Mensagem não reconhecida' });
    }
  })();
  return true; // keep async sendResponse channel open
});

if (chrome.tabs && chrome.tabs.onReplaced) {
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const oldState = TAB_STATES.get(removedTabId);
    if (oldState) {
      TAB_STATES.delete(removedTabId);
      const migrated = Object.assign({}, oldState, { tabId: addedTabId, lastActivityAt: Date.now() });
      TAB_STATES.set(addedTabId, migrated);
      if (migrated.autoContinueEnabled) {
        protectTabFromFreeze(addedTabId, true);
      }
      persistTabStates();
    }
    if (TAB_BINDING_EPOCHS.has(removedTabId)) {
      TAB_BINDING_EPOCHS.set(addedTabId, TAB_BINDING_EPOCHS.get(removedTabId));
      TAB_BINDING_EPOCHS.delete(removedTabId);
    }
    const oldJob = PENDING_JOBS.get(removedTabId);
    if (oldJob) {
      PENDING_JOBS.delete(removedTabId);
      PENDING_JOBS.set(addedTabId, oldJob);
    }
    if (SLOT_INITIAL_PROMPTS.has(removedTabId)) {
      SLOT_INITIAL_PROMPTS.set(addedTabId, SLOT_INITIAL_PROMPTS.get(removedTabId));
      SLOT_INITIAL_PROMPTS.delete(removedTabId);
    }
    if (oldJob || SLOT_INITIAL_PROMPTS.has(addedTabId)) {
      persistVolatileWorkerState();
    }
    for (const room of COLLAB_ROOMS.values()) {
      let touched = false;
      for (const ag of room.agents || []) {
        if (ag.tabId === removedTabId) {
          ag.tabId = addedTabId;
          touched = true;
        }
      }
      if (room.externalTabId === removedTabId) {
        room.externalTabId = addedTabId;
        EXT_TAB_TO_ROOM.delete(removedTabId);
        EXT_TAB_TO_ROOM.set(addedTabId, room.roomId);
        if (EXT_TAB_BINDING_TOKENS.has(removedTabId)) {
          EXT_TAB_BINDING_TOKENS.set(addedTabId, EXT_TAB_BINDING_TOKENS.get(removedTabId));
          EXT_TAB_BINDING_TOKENS.delete(removedTabId);
        }
        touched = true;
      }
      if (touched) persistCollabRooms();
    }
    ACTIVE_PORTS.delete(removedTabId);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const closing = TAB_STATES.get(tabId);
  if (closing && closing.url) {
    const ck = extractConvKey(closing.url);
    if (ck && cachedConvStates[ck]) {
      delete cachedConvStates[ck];
    }
  }
  if (EXT_TAB_TO_ROOM.has(tabId)) {
    const rId = EXT_TAB_TO_ROOM.get(tabId);
    EXT_TAB_TO_ROOM.delete(tabId);
    EXT_TAB_BINDING_TOKENS.delete(tabId);
    const room = COLLAB_ROOMS.get(rId);
    if (room && room.externalTabId === tabId) {
      room.externalTabId = null;
      persistCollabRooms();
    }
  }
  for (const room of COLLAB_ROOMS.values()) {
    let closedMember = false;
    for (const ag of room.agents || []) {
      if (ag.tabId === tabId && !ag.closed) {
        ag.closed = true;
        closedMember = true;
      }
    }
    if (closedMember) {
      ensureHealthySynthesizerLeader(room);
      persistCollabRooms();
    }
  }
  TAB_STATES.delete(tabId);
  TAB_BINDING_EPOCHS.delete(tabId);
  const hadJob = PENDING_JOBS.delete(tabId);
  const hadSlotPrompt = SLOT_INITIAL_PROMPTS.delete(tabId);
  if (hadJob || hadSlotPrompt) {
    persistVolatileWorkerState();
  }
  LAST_TAB_GH_PUSH_SIG.delete(tabId);
  ACTIVE_PORTS.delete(tabId);
  PROTECTED_TABS.delete(tabId);
  persistTabStates(true);
  refreshExtensionBadge();
  ensureAntiThrottleHeartbeat();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || typeof changeInfo.discarded === 'boolean') {
    const effectiveUrl = (tab && (tab.url || tab.pendingUrl)) || '';
    if (isArenaUrl(effectiveUrl) || PENDING_JOBS.has(tabId)) {
      const convKey = extractConvKey(effectiveUrl);
      const convSaved = convKey ? cachedConvStates[convKey] : null;
      const safeSaved = Object.assign({}, convSaved || {});
      // ARENA-18: Never inherit collabRoomId from URL cache unless tabId is registered in that room!
      if (safeSaved.collabRoomId) {
        const rCheck = COLLAB_ROOMS.get(safeSaved.collabRoomId);
        const agCheck = rCheck && (rCheck.agents || []).find((a) => a && a.tabId === tabId && !a.closed);
        if (!agCheck) {
          delete safeSaved.collabRoomId;
          delete safeSaved.collabAgentName;
        }
      }
      const prev = TAB_STATES.get(tabId) || Object.assign(
        { tabId, loopsCount: 0, autoContinueEnabled: false, status: 'idle' },
        safeSaved
      );
      if (effectiveUrl) prev.url = effectiveUrl;
      if (tab && tab.title) prev.title = tab.title;
      if (effectiveUrl) prev.mode = detectModeFromUrl(effectiveUrl);
      TAB_STATES.set(tabId, prev);
      if (prev.autoContinueEnabled) {
        protectTabFromFreeze(tabId, true);
      }
      persistTabStates();
    } else if (effectiveUrl && effectiveUrl !== 'about:blank' && TAB_STATES.has(tabId)) {
      TAB_STATES.delete(tabId);
      persistTabStates();
      refreshExtensionBadge();
    }
  }
  if (changeInfo.status === 'complete') {
    if (PENDING_JOBS.has(tabId)) {
      const job = PENDING_JOBS.get(tabId);
      job.lastPushAt = Date.now();
      chrome.tabs.sendMessage(tabId, { type: 'AU_RUN_PENDING_JOB', job }).catch(() => {});
    }
    const st = TAB_STATES.get(tabId);
    if (st && st.autoContinueEnabled && st.status !== 'token_stopped') {
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: 'AU_HEARTBEAT_TICK', now: Date.now() }).catch(() => {});
      }, 900);
    }
  }
});

chrome.alarms.create('au_anti_throttle_alarm', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name) return;
  if (alarm.name === 'au_anti_throttle_alarm') {
    syncOpenArenaTabs();
    broadcastTickToActiveTabs();
    return;
  }
  // PROD-03: Scheduled Task Runner via chrome.alarms
  if (typeof AU_SCHEDULER !== 'undefined' && alarm.name.startsWith(AU_SCHEDULER.ALARM_PREFIX)) {
    const schedId = alarm.name.slice(AU_SCHEDULER.ALARM_PREFIX.length);
    try {
      const list = await AU_SCHEDULER.getSchedules();
      const item = list.find((s) => s && s.id === schedId && s.enabled);
      if (item && item.launchConfig) {
        await launchMultiAgentBatch(item.launchConfig);
        item.lastRunAt = Date.now();
        item.runCount = Number(item.runCount || 0) + 1;
        await AU_SCHEDULER.upsertSchedule(item);
      }
    } catch (e) {
      AU_STORAGE.recordDiagnostic({
        level: 'error',
        source: 'scheduler',
        code: 'SCHED_EXEC_ERROR',
        message: (e && e.message) || String(e)
      }).catch(() => {});
    }
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await AU_STORAGE.runSchemaMigrations();
  await AU_STORAGE.getPrompts();
  await AU_STORAGE.getMacros();
  await AU_STORAGE.getFolders();
  if (typeof AU_SCHEDULER !== 'undefined' && AU_SCHEDULER.syncChromeAlarms) {
    await AU_SCHEDULER.syncChromeAlarms().catch(() => {});
  }

  // Inject into any already-open Arena.ai tabs so the user can use it right away!
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (isArenaUrl(t.url) && chrome.scripting) {
        chrome.scripting.executeScript({
          target: { tabId: t.id },
          world: 'MAIN',
          files: ['content/page-bridge.js']
        }).catch(() => {});
        chrome.scripting.executeScript({
          target: { tabId: t.id },
          files: CONTENT_ISOLATED_SCRIPTS
        }).catch(() => {});
      }
    }
  } catch (_) {}

  await ensureCollabRoomsLoaded();
  await syncOpenArenaTabs();
});

ensureCollabRoomsLoaded().then(() => {
  syncOpenArenaTabs();
  if (typeof AU_SCHEDULER !== 'undefined' && AU_SCHEDULER.syncChromeAlarms) {
    AU_SCHEDULER.syncChromeAlarms().catch(() => {});
  }
});
