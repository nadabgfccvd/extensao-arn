(function () {
  'use strict';

  const EXTENSION_VERSION =
    (typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.getManifest === 'function' &&
      chrome.runtime.getManifest().version) ||
    '3.3.2';
  if (window.__ARENA_ULTRA_VERSION__ === EXTENSION_VERSION) return;
  window.__ARENA_ULTRA_VERSION__ = EXTENSION_VERSION;
  window.__ARENA_ULTRA_LOADED__ = true;

  const INSTANCE_ID = 'au_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  document.documentElement.setAttribute('data-au-instance', INSTANCE_ID);
  function isCurrentInstance() {
    return document.documentElement.getAttribute('data-au-instance') === INSTANCE_ID;
  }

  const AU_DEFAULTS = window.AU_DEFAULTS;
  const AU_STORAGE = window.AU_STORAGE;
  const AU_THEMES = window.AU_THEMES;
  const AU_INTEGRATIONS = window.AU_INTEGRATIONS;
  const AU_ARENA_ADAPTER = window.AU_ARENA_ADAPTER || null;
  const AU_CRED_BROKER = window.AU_CRED_BROKER || null;
  const AU_I18N = window.AU_I18N || null;

  // --- Runtime State ---
  let settings = Object.assign({}, AU_DEFAULTS.DEFAULT_SETTINGS);
  let promptsList = [];
  let macrosList = [];
  let foldersList = [];

  const runtime = {
    tabId: null,
    autoContinueEnabled: false,
    strategy: 'hybrid', // 'hybrid' | 'fixed' | 'queue' | 'conditional'
    customFixedPrompt: '',
    promptQueue: [],
    status: 'idle', // 'idle' | 'generating' | 'waiting_send' | 'waiting_user' | 'needs_human' | 'token_stopped' | 'paused' | 'captcha_waiting'
    stopReason: '',
    loopsCount: 0,
    estimatedSessionTokens: 0,
    currentInputTokens: 0,
    netActiveStreams: 0,
    lastNetChunkAt: 0,
    lastContentGrowthAt: Date.now() - 5000,
    lastObservedMainChars: -1,
    lastTickAt: 0,
    sawActivitySinceLastSend: false,
    justEnabledReadyToFire: false,
    sendingInProgress: false,
    lastSendAt: 0,
    lastAttemptedPrompt: '',
    pendingCaptchaPrompt: '',
    pendingCaptchaSource: '',
    pendingLaunchJobId: null,
    collabRoomId: '',
    collabBindingEpoch: 0,
    collabAgentName: '',
    collabWaitingPeers: false,
    selectedDrawerRoomId: '',
    drawerOpen: false,
    activeDrawerTab: 'autopilot',
    initialSessionPrompt: '',
    jobRefuseThinking: null,
    refusingInProgress: false,
    fastScreeningTimer: null,
    fastScreeningObserver: null,
    admittedToTeam: false,
    githubActive: false,
    hasVaultToken: false,
    githubRepo: '',
    githubBaseBranch: '',
    githubBranch: '',
    lastSoloGithubSyncHash: '',
    pendingReloadPrompt: '',
    cleanConvPathConfirmed: '',
    lastCreatedConvId: '',
    boundConvKey: '',
    filteredReasoningBlocks: 0,
    pendingHumanInteraction: '',
    rerollAttempt: 0,
    lastTransientErrorAt: 0,
    lastTransientErrorReason: '',
    lastTransientRetryAt: 0,
    transientRetryCount: 0,
    initialLaunchSentAt: 0,
    lastLiveStreamedChatHash: '',
    lastSwHeartbeatAt: 0,
    lastMidTurnCheckAt: 0,
    lastSlowGuardCheckAt: 0,
    lastAutoSaveAt: 0,
    lastSessionStorageSig: '',
    slashPopupOpen: false,
    slashQuery: '',
    originalTitle: document.title || 'Arena.ai',
    blinkTimer: null,
    keepAlivePort: null,
    webLockAbort: null
  };

  // --- Inject MAIN-world Page Bridge for Tiptap/ProseMirror & stream telemetry ---
  const EXPECTED_BRIDGE_VERSION = '4.0.0';
  const pendingBridgeCallbacks = new Map();

  // SEC-07: Per-document CSPRNG nonce + 2-way handshake token with MAIN-world page-bridge.js
  function generateIsoBridgeNonce() {
    try {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b)
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    } catch (_) {
      return 'iso_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }
  const isoBridgeNonce = generateIsoBridgeNonce();
  let bridgeSessionToken = '';
  let lastHandshakeSentAt = 0;

  function sendBgMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function postToMainWorld(event, detail, isHandshakeInit = false) {
    try {
      const targetOrigin = (location && location.origin && location.origin !== 'null') ? location.origin : 'https://arena.ai';
      window.postMessage(
        {
          __au_ipc_v2__: true,
          dir: 'iso->main',
          token: isHandshakeInit ? '' : bridgeSessionToken,
          event,
          detail: detail || {}
        },
        targetOrigin
      );
    } catch (_) {}
  }

  function requestBridgeHandshake() {
    const now = Date.now();
    if (bridgeSessionToken || now - lastHandshakeSentAt < 60) return;
    lastHandshakeSentAt = now;
    postToMainWorld('au-bridge-handshake-init', { isoNonce: isoBridgeNonce }, true);
  }

  function injectPageBridge() {
    if (
      document.documentElement.getAttribute('data-au-bridge-ready') === '1' &&
      document.documentElement.getAttribute('data-au-bridge-version') === EXPECTED_BRIDGE_VERSION
    ) {
      requestBridgeHandshake();
      return;
    }
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('content/page-bridge.js');
      s.onload = () => {
        s.remove();
        requestBridgeHandshake();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {}
    try {
      chrome.runtime.sendMessage({ type: 'AU_ENSURE_MAIN_BRIDGE' }, () => {
        void chrome.runtime.lastError;
        requestBridgeHandshake();
      });
    } catch (_) {}
  }

  function bgSafeSleep(ms) {
    const waitMs = Math.max(15, Number(ms) || 50);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      setTimeout(finish, waitMs);
      try {
        chrome.runtime.sendMessage({ type: 'AU_BG_SLEEP', ms: waitMs }, () => {
          void chrome.runtime.lastError;
          finish();
        });
      } catch (_) {}
    });
  }

  async function ensurePageBridgeReady(maxWaitMs = 3500) {
    injectPageBridge();
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (
        document.documentElement.getAttribute('data-au-bridge-ready') === '1' &&
        document.documentElement.getAttribute('data-au-bridge-version') === EXPECTED_BRIDGE_VERSION
      ) {
        if (bridgeSessionToken) return true;
        requestBridgeHandshake();
      }
      await bgSafeSleep(70);
    }
    if (!bridgeSessionToken) requestBridgeHandshake();
    return Boolean(bridgeSessionToken) && document.documentElement.getAttribute('data-au-bridge-ready') === '1';
  }

  async function sendBridgeCommand(action, text, timeoutMs = 8500, extra = {}) {
    await ensurePageBridgeReady(2500);
    return new Promise((resolve) => {
      const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      let settled = false;

      bgSafeSleep(timeoutMs).then(() => {
        if (settled) return;
        settled = true;
        pendingBridgeCallbacks.delete(requestId);
        resolve({ ok: false, reason: 'bridge_timeout' });
      });

      pendingBridgeCallbacks.set(requestId, (res) => {
        if (settled) return;
        settled = true;
        resolve(res || { ok: false });
      });

      postToMainWorld(
        'au-bridge-command',
        Object.assign({ requestId, action, text }, extra && typeof extra === 'object' ? extra : {})
      );
    });
  }

  // ARENA-03: Reset per-conversation runtime state when user navigates SPA routes to a different conversation
  function resetRuntimeForNewConversation(newConvKey, reason = 'route_change') {
    runtime.boundConvKey = newConvKey || '';
    runtime.sawActivitySinceLastSend = false;
    runtime.justEnabledReadyToFire = false;
    runtime.sendingInProgress = false;
    runtime.netActiveStreams = 0;
    runtime.pendingHumanInteraction = '';
    runtime.lastLiveStreamedChatHash = '';
    runtime.lastSoloGithubSyncHash = '';
    runtime.cleanConvPathConfirmed = '';
    // If user manually clicked New Chat or another sidebar chat while not in an anti-thinking re-roll, pause solo loop safely
    if (!activeJobRunning && !runtime.refusingInProgress && !runtime.pendingReloadPrompt) {
      if (runtime.autoContinueEnabled && !runtime.collabRoomId) {
        runtime.autoContinueEnabled = false;
        runtime.promptQueue = [];
        runtime.status = 'idle';
        runtime.stopReason = '';
        updateWebLock();
      } else if (runtime.status === 'waiting_user' || runtime.status === 'generating') {
        runtime.status = 'idle';
      }
    }
    syncTabStateToBackground();
    renderToolbarAndDrawerStatus();
  }

  // SEC-07: Unified Cross-World Structured-Clone IPC listener from MAIN-world page-bridge.js
  window.addEventListener('message', (ev) => {
    if (!isCurrentInstance()) return;
    if (!ev || ev.source !== window) return;
    if (location && location.origin && ev.origin !== location.origin) return;
    const msg = ev.data;
    if (!msg || !msg.__au_ipc_v2__ || msg.dir !== 'main->iso') return;
    const d = msg.detail || {};

    if (msg.event === 'au-bridge-handshake-ack') {
      if (d.isoNonce === isoBridgeNonce && typeof d.mainNonce === 'string' && d.mainNonce.length >= 16) {
        bridgeSessionToken = `${isoBridgeNonce}:${d.mainNonce}`;
      }
      return;
    }

    if (!bridgeSessionToken || msg.token !== bridgeSessionToken) {
      if (AU_STORAGE && typeof AU_STORAGE.appendDiagnosticEvent === 'function') {
        AU_STORAGE.appendDiagnosticEvent({
          level: 'warn',
          source: 'content-ipc',
          code: 'SEC07_UNTRUSTED_MAIN_MSG',
          message: `Ignored unauthenticated cross-world message (${String(msg.event || '').slice(0, 32)})`
        });
      }
      return;
    }

    if (msg.event === 'au-bridge-result') {
      if (!d.requestId) return;
      const cb = pendingBridgeCallbacks.get(d.requestId);
      if (cb) {
        pendingBridgeCallbacks.delete(d.requestId);
        cb(d);
      }
      return;
    }

    if (msg.event === 'au-bg-sleep-req') {
      if (!d.id) return;
      bgSafeSleep(d.ms || 100).then(() => {
        postToMainWorld('au-bg-sleep-res', { id: d.id });
      });
      return;
    }

    if (msg.event === 'au-network-telemetry') {
      if (d.type === 'untrusted_ipc_rejected') {
        if (AU_STORAGE && typeof AU_STORAGE.appendDiagnosticEvent === 'function') {
          AU_STORAGE.appendDiagnosticEvent({
            level: 'warn',
            source: 'page-bridge',
            code: 'SEC07_PAGE_SPOOF_BLOCKED',
            message: d.reason || 'Untrusted page script postMessage blocked'
          });
        }
        return;
      }
      if (d.type === 'route_change') {
        const nextConvKey = d.convId ? `/${d.convId}` : extractConvKeyFromHref(location.href);
        const createdKey = runtime.lastCreatedConvId ? `/${runtime.lastCreatedConvId}` : '';
        const isInitialSessionHydration =
          !runtime.boundConvKey && nextConvKey && (Date.now() - runtime.lastSendAt < 30000 || nextConvKey === createdKey);
        if (isInitialSessionHydration) {
          runtime.boundConvKey = nextConvKey;
          saveToTabSessionStorage();
          syncTabStateToBackground();
        } else if (nextConvKey !== runtime.boundConvKey) {
          resetRuntimeForNewConversation(nextConvKey, d.trigger || 'route_change');
        }
        return;
      }
      if (d.type === 'stream_start' || d.type === 'stream_chunk') {
        runtime.netActiveStreams = Number(d.activeStreams || 1);
        runtime.lastNetChunkAt = Date.now();
        runtime.lastContentGrowthAt = Date.now();
        runtime.sawActivitySinceLastSend = true;
        runtime.lastTransientErrorAt = 0;
        runtime.lastTransientErrorReason = '';
        runtime.transientRetryCount = 0;
        runtime.pendingCaptchaPrompt = '';
        if (runtime.status === 'captcha_waiting' || (runtime.autoContinueEnabled && runtime.status !== 'token_stopped')) {
          runtime.status = 'generating';
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
        }
      } else if (d.type === 'stream_end') {
        runtime.netActiveStreams = Math.max(0, Number(d.activeStreams || 0));
        if (runtime.netActiveStreams === 0 && runtime.status === 'generating' && !findStopButton()) {
          runtime.status = 'idle';
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
        }
      } else if (d.type === 'session_created') {
        if (d.convId) {
          runtime.lastCreatedConvId = String(d.convId);
        }
      } else if (d.type === 'user_prompt_observed') {
        const obs = String(d.prompt || '').trim();
        if (obs) {
          runtime.lastAttemptedPrompt = obs;
          if (!runtime.lastSendAt) runtime.lastSendAt = Date.now();
          if (d.isCreate && !runtime.initialSessionPrompt) {
            runtime.initialSessionPrompt = obs;
            try {
              chrome.runtime.sendMessage({ type: 'AU_REMEMBER_INITIAL_PROMPT', prompt: obs });
            } catch (_) {}
          }
        }
      } else if (d.type === 'transient_session_error') {
        runtime.lastTransientErrorAt = Date.now();
        runtime.lastTransientErrorReason = d.reason || 'Failed to start session';
        runtime.netActiveStreams = 0;
        if (runtime.status === 'generating' && !findStopButton()) {
          runtime.status = 'idle';
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
        }
      } else if (d.type === 'http_rate_or_challenge') {
        setTimeout(() => {
          if (detectSecurityVerificationOnPage()) {
            enterCaptchaWaitingState(runtime.lastAttemptedPrompt || '', runtime.lastAttemptedSource || 'auto');
          }
        }, 450);
      } else if (d.type === 'stream_reasoning_detected') {
        if (isRefuseThinkingActive() && !runtime.refusingInProgress && !detectSecurityVerificationOnPage()) {
          stopAndRefuseThinkingModel(d.reason || 'Thinking...');
        }
      } else if (d.type === 'http_limit' || d.type === 'stream_limit_text') {
        if (!detectSecurityVerificationOnPage() && runtime.autoContinueEnabled && settings.hardStopOnTokenLimit) {
          triggerImmediateTokenStop(d.reason || 'Limite de tokens/créditos atingido');
        }
      }
    }
  });

  // --- Anti-Throttling Web Lock, Memory-Saver Session Persistence & Port ---
  const TAB_SESSION_STORAGE_KEY = 'au_tab_autopilot_v2';

  function extractConvKeyFromHref(href) {
    try {
      const u = new URL(href || location.href);
      const m = u.pathname.match(/\/(?:c|agent)\/([^/?#]+)/i);
      return m ? `/${m[1]}` : '';
    } catch (_) {
      return '';
    }
  }

  function saveToTabSessionStorage() {
    try {
      const payload = {
        autoContinueEnabled: Boolean(runtime.autoContinueEnabled),
        harnessInitialized: Boolean(runtime.harnessInitialized),
        strategy: runtime.strategy || 'hybrid',
        customFixedPrompt: runtime.customFixedPrompt || '',
        promptQueue: Array.isArray(runtime.promptQueue) ? runtime.promptQueue.slice() : [],
        status: runtime.status || 'idle',
        loopsCount: Number(runtime.loopsCount || 0),
        stopReason: runtime.stopReason || '',
        collabRoomId: runtime.collabRoomId || '',
        collabBindingEpoch: Number(runtime.collabBindingEpoch || 0),
        collabAgentName: runtime.collabAgentName || '',
        githubActive: Boolean(runtime.githubActive),
        githubRepo: runtime.githubRepo || '',
        githubBaseBranch: runtime.githubBaseBranch || '',
        githubBranch: runtime.githubBranch || '',
        pendingReloadPrompt: runtime.pendingReloadPrompt || '',
        convKey: extractConvKeyFromHref(location.href),
        updatedAt: Date.now()
      };
      sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  // ARENA-18: Room binding is ONLY restored when allowRoomRestore=true (authoritative SW response),
  // NEVER self-claimed from tab sessionStorage!
  function applyRestoredAutopilotSnapshot(snap, allowRoomRestore = false) {
    if (!snap || typeof snap !== 'object') return false;
    runtime.harnessInitialized = Boolean(snap.harnessInitialized);
    if (allowRoomRestore && snap.collabRoomId) {
      runtime.collabRoomId = String(snap.collabRoomId);
      runtime.collabBindingEpoch = Number(snap.collabBindingEpoch || snap.bindingEpoch || 1);
      runtime.selectedDrawerRoomId = runtime.collabRoomId;
      if (snap.collabAgentName) {
        runtime.collabAgentName = snap.collabAgentName;
      }
    }
    if (snap.githubActive) {
      runtime.githubActive = true;
      if (snap.githubRepo) runtime.githubRepo = snap.githubRepo;
      if (snap.githubBaseBranch) runtime.githubBaseBranch = snap.githubBaseBranch;
      if (snap.githubBranch) runtime.githubBranch = snap.githubBranch;
    }
    if (typeof snap.pendingReloadPrompt === 'string' && snap.pendingReloadPrompt.trim()) {
      runtime.pendingReloadPrompt = snap.pendingReloadPrompt.trim();
    }
    if (snap.status === 'token_stopped' || snap.status === 'needs_human') {
      runtime.autoContinueEnabled = false;
      runtime.status = snap.status;
      runtime.stopReason = snap.stopReason || '';
      if (typeof snap.loopsCount === 'number') runtime.loopsCount = snap.loopsCount;
      return false;
    }
    if (!snap.autoContinueEnabled && !runtime.pendingReloadPrompt) return false;

    if (snap.autoContinueEnabled) {
      runtime.autoContinueEnabled = true;
    } else if (runtime.pendingReloadPrompt) {
      runtime.initialLaunchSentAt = Date.now();
    }
    if (snap.strategy) runtime.strategy = snap.strategy;
    if (typeof snap.customFixedPrompt === 'string' && snap.customFixedPrompt) {
      runtime.customFixedPrompt = snap.customFixedPrompt;
    }
    if (Array.isArray(snap.promptQueue) && snap.promptQueue.length > 0 && runtime.promptQueue.length === 0) {
      runtime.promptQueue = snap.promptQueue.slice();
    }
    if (typeof snap.loopsCount === 'number' && snap.loopsCount > runtime.loopsCount) {
      runtime.loopsCount = snap.loopsCount;
    }
    runtime.status = 'idle';
    runtime.sawActivitySinceLastSend = true;
    runtime.justEnabledReadyToFire = false;
    updateWebLock();
    return true;
  }

  function restoreFromTabSessionStorage() {
    try {
      const raw = sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return false;
      if (saved.updatedAt && Date.now() - saved.updatedAt > 86400000) return false;
      const currentConv = extractConvKeyFromHref(location.href);
      if (saved.convKey && !currentConv) {
        return false;
      }
      if (saved.convKey && currentConv && saved.convKey !== currentConv) {
        return false;
      }
      // ARENA-18: Pass allowRoomRestore=false so sessionStorage never resurrects an unbound room!
      return applyRestoredAutopilotSnapshot(saved, false);
    } catch (_) {
      return false;
    }
  }

  function updateWebLock() {
    if (runtime.autoContinueEnabled && settings.antiThrottleEnabled) {
      if (navigator.locks && !runtime.webLockAbort) {
        const controller = new AbortController();
        runtime.webLockAbort = controller;
        navigator.locks
          .request(
            'arena_ultra_active_lock_' + Math.random().toString(36).slice(2, 7),
            { signal: controller.signal },
            () => new Promise(() => {})
          )
          .catch(() => {});
      }
    } else {
      if (runtime.webLockAbort) {
        try {
          runtime.webLockAbort.abort();
        } catch (_) {}
        runtime.webLockAbort = null;
      }
    }
  }

  function buildTabStatePayload() {
    return {
      url: location.href,
      title: runtime.originalTitle || document.title || 'Arena.ai',
      mode: detectCurrentArenaMode(),
      autoContinueEnabled: runtime.autoContinueEnabled,
      strategy: runtime.strategy,
      customFixedPrompt: runtime.customFixedPrompt || '',
      promptQueue: Array.isArray(runtime.promptQueue) ? runtime.promptQueue.slice() : [],
      status: runtime.status,
      loopsCount: runtime.loopsCount,
      queueLength: runtime.promptQueue.length,
      estimatedTokens: runtime.estimatedSessionTokens + runtime.currentInputTokens,
      stopReason: runtime.stopReason,
      collabRoomId: runtime.collabRoomId || '',
      collabBindingEpoch: Number(runtime.collabBindingEpoch || 0),
      collabAgentName: runtime.collabAgentName || '',
      filteredReasoningBlocks: Number(runtime.filteredReasoningBlocks || 0),
      pendingHumanInteraction: runtime.pendingHumanInteraction || '',
      githubActive: Boolean(runtime.githubActive),
      githubRepo: runtime.githubRepo || '',
      githubBaseBranch: runtime.githubBaseBranch || '',
      githubBranch: runtime.githubBranch || ''
    };
  }

  function connectKeepAlivePort() {
    if (!isCurrentInstance()) return;
    try {
      const port = chrome.runtime.connect({ name: 'au-keepalive' });
      runtime.keepAlivePort = port;
      // Safe now because bootstrap() restores persisted state BEFORE calling connectKeepAlivePort()!
      syncTabStateToBackground();

      port.onMessage.addListener((msg) => {
        if (!isCurrentInstance()) {
          try { port.disconnect(); } catch (_) {}
          return;
        }
        if (msg && msg.type === 'AU_HEARTBEAT_TICK') {
          runtime.lastSwHeartbeatAt = Date.now();
          const stPayload = buildTabStatePayload();
          const stSig = `${stPayload.autoContinueEnabled ? 1 : 0}|${stPayload.status}|${stPayload.loopsCount}|${stPayload.queueLength}|${stPayload.stopReason}|${stPayload.collabRoomId}|${stPayload.githubActive ? 1 : 0}|${stPayload.githubBranch}`;
          if (stSig !== runtime.lastSessionStorageSig) {
            runtime.lastSessionStorageSig = stSig;
            saveToTabSessionStorage();
          }
          try {
            port.postMessage({
              type: 'AU_HEARTBEAT_PONG',
              state: stPayload
            });
          } catch (_) {}
          evaluateAutoContinueTick();
        }
      });
      port.onDisconnect.addListener(() => {
        runtime.keepAlivePort = null;
        if (!isCurrentInstance()) return;
        bgSafeSleep(1500).then(() => {
          if (isCurrentInstance() && chrome.runtime && chrome.runtime.id) {
            connectKeepAlivePort();
          }
        });
      });
    } catch (_) {}
  }

  function detectCurrentArenaMode() {
    const url = location.href;
    if (/\/agent(\/|$|\?)/i.test(url) || /[?&]mode=agent/i.test(url)) return 'agent';
    if (/\/battle(\/|$|\?)/i.test(url) || /[?&]mode=battle/i.test(url)) return 'battle';
    const headerText = (document.querySelector('header')?.innerText || '').toLowerCase();
    if (headerText.includes('agent mode') || headerText.includes('agent')) return 'agent';
    if (headerText.includes('battle')) return 'battle';
    return 'chat';
  }

  function syncTabStateToBackground() {
    saveToTabSessionStorage();
    const statePayload = buildTabStatePayload();
    if (runtime.keepAlivePort) {
      try {
        runtime.keepAlivePort.postMessage({ type: 'AU_TAB_STATE_UPDATE', state: statePayload });
        return;
      } catch (_) {}
    }
    try {
      chrome.runtime.sendMessage({ type: 'AU_TAB_STATE_UPDATE', state: statePayload });
    } catch (_) {}
  }

  // --- Arena DOM Helpers ---
  function isElementDisplayed(el) {
    if (!el || !el.isConnected) return false;
    let cur = el;
    for (let d = 0; d < 8 && cur && cur.nodeType === 1; d++) {
      const st = window.getComputedStyle(cur);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      cur = cur.parentElement;
    }
    return true;
  }

  function isVisible(el) {
    if (!isElementDisplayed(el)) return false;
    // In collapsed/background Tab Groups or minimized windows, Blink can skip layout reflow so rect is 0x0!
    if (document.hidden || window.innerWidth === 0 || window.outerWidth === 0) {
      return true;
    }
    // Never reject opacity:0! On Windows Virtual Desktop 2 ("Área de trabalho 2"),
    // document.hidden is false while DWM Cloaking pauses CSS/Framer-Motion fade-ins at opacity:0!
    const rect = el.getBoundingClientRect();
    return !(rect.width === 0 && rect.height === 0);
  }

  function findChatInput() {
    // 1. Arena.ai Tiptap / ProseMirror rich editor (Agent Mode & new Composer)
    const rteSelectors = [
      '.editor-content .tiptap[contenteditable="true"]',
      '.editor-content .ProseMirror[contenteditable="true"]',
      '.tiptap.ProseMirror[contenteditable="true"]',
      '.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][translate="no"]',
      '[contenteditable="true"][role="textbox"]'
    ];
    for (const sel of rteSelectors) {
      const list = Array.from(document.querySelectorAll(sel)).filter(
        (el) =>
          el.isConnected &&
          isElementDisplayed(el) &&
          !el.closest('#arena-ultra-root') &&
          !el.closest('#arena-ultra-toolbar-host') &&
          el.getAttribute('aria-disabled') !== 'true'
      );
      if (list.length > 0) return list[0];
    }

    // 2. Standard <textarea> fallback (when enableRTE is false)
    const candidates = Array.from(
      document.querySelectorAll('form textarea, main textarea, textarea:not([readonly])')
    ).filter((el) => {
      if (!el.isConnected || !isElementDisplayed(el)) return false;
      if (el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host')) return false;
      if (el.readOnly || el.disabled) return false;
      return true;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    return candidates[0];
  }

  // Detect Arena Agent Mode's end-of-turn Task Review Panel ("Esta tarefa foi bem-sucedida?" / "Isso conclui sua tarefa?" / "Continuar trabalhando")
  function findTaskReviewPanel() {
    const keepWorkingLabels = [
      'continuar trabalhando',
      'continuar a trabalhar',
      'continue working',
      'keep working',
      'seguir trabajando',
      'continuar trabajando',
      'continuer à travailler'
    ];
    const reviewQuestionPatterns = [
      'bem-sucedida',
      'conclui sua tarefa',
      'task successful',
      'complete your task',
      'task succeed',
      'éxito esta tarea',
      'completa tu tarea',
      'tâche a-t-elle réussi'
    ];

    const scopeRoot = document.querySelector('main') || document.body || document;
    let keepWorkingBtn = null;
    let closeBtn = null;
    let reviewCard = null;

    // Fast pass on buttons first; only scan generic hoverable wrappers if buttons didn't match!
    const selectorPasses = [
      'button, [role="button"]',
      '[tabindex="0"], div.cursor-pointer, div[class*="hover:"]'
    ];

    for (const sel of selectorPasses) {
      const clickables = scopeRoot.querySelectorAll(sel);
      for (let i = 0; i < clickables.length; i++) {
        const el = clickables[i];
        if (
          !el.isConnected ||
          el.closest('#arena-ultra-root') ||
          el.closest('#arena-ultra-toolbar-host') ||
          !isElementDisplayed(el)
        ) {
          continue;
        }

        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (
          label.includes('close review panel') ||
          label.includes('review panel') ||
          label.includes('painel de revis') ||
          label.includes('panel de revis')
        ) {
          closeBtn = el;
        }

        const norm = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (norm.length > 0 && norm.length < 48 && keepWorkingLabels.some((lbl) => norm === lbl || norm.includes(lbl))) {
          let card = el.parentElement;
          for (let up = 0; up < 6 && card; up++) {
            const cardTxt = (card.textContent || '').toLowerCase();
            if (
              cardTxt.length > 0 &&
              cardTxt.length < 600 &&
              (reviewQuestionPatterns.some((p) => cardTxt.includes(p)) ||
                ((cardTxt.includes('sim') && cardTxt.includes('não')) ||
                  (cardTxt.includes('yes') && cardTxt.includes('no'))))
            ) {
              keepWorkingBtn =
                el.closest('button, [role="button"]') ||
                (el.querySelector && el.querySelector('button, [role="button"]')) ||
                el;
              reviewCard = card;
              break;
            }
            card = card.parentElement;
          }
          if (keepWorkingBtn) break;
        }
      }
      if (keepWorkingBtn) break;
    }

    if (!keepWorkingBtn && closeBtn) {
      let card = closeBtn.parentElement;
      for (let up = 0; up < 4 && card; up++) {
        const opts = Array.from(card.querySelectorAll('button, [role="button"]')).filter((b) => b !== closeBtn);
        if (opts.length >= 3) {
          keepWorkingBtn = opts[opts.length - 1];
          reviewCard = card;
          break;
        }
        card = card.parentElement;
      }
      if (!reviewCard) reviewCard = closeBtn.closest('div.border, div[class*="rounded"]') || closeBtn.parentElement;
    }

    if (!keepWorkingBtn && !closeBtn) return null;

    // Walk reviewCard up to the outer card wrapper containing the question header ("Esta tarefa foi bem-sucedida?")
    // so the Arena Ultra toolbar mounts ABOVE the card rather than splitting header and options!
    if (reviewCard) {
      let outer = reviewCard;
      for (let up = 0; up < 3 && outer.parentElement; up++) {
        const pTxt = (outer.parentElement.innerText || '').toLowerCase();
        if (pTxt.length > 0 && pTxt.length < 650 && reviewQuestionPatterns.some((p) => pTxt.includes(p))) {
          outer = outer.parentElement;
        } else {
          break;
        }
      }
      reviewCard = outer;
    }

    return {
      card: reviewCard || (keepWorkingBtn && keepWorkingBtn.closest('div[class*="rounded"]')) || (keepWorkingBtn && keepWorkingBtn.parentElement),
      keepWorkingBtn,
      closeBtn
    };
  }

  function findComposerAnchor(inputEl) {
    const el = inputEl || findChatInput() || document.querySelector('.editor-content');
    if (el) {
      return (
        el.closest('.bg-surface-secondary') ||
        el.closest('form') ||
        (el.closest('.editor-content') && el.closest('.editor-content').parentElement?.parentElement?.parentElement) ||
        el.parentElement
      );
    }
    const review = findTaskReviewPanel();
    if (review && review.card) {
      return review.card;
    }
    return null;
  }

  function isTrueStopGenerationLabel(rawLabel) {
    if (!rawLabel) return false;
    const lbl = String(rawLabel).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!lbl) return false;
    // Never false-positive on past-tense badges ("Generation stopped", "Rerun stopped messages") or workspace "Stop process"
    if (
      lbl.includes('stopped') ||
      lbl.includes('rerun') ||
      lbl.includes('process') ||
      lbl.includes('server') ||
      lbl.includes('preview') ||
      lbl.includes('speech') ||
      lbl.includes('audio') ||
      lbl.includes('video') ||
      lbl.includes('workspace') ||
      lbl.includes('files') ||
      lbl.includes('connections')
    ) {
      return false;
    }
    return (
      lbl === 'stop' ||
      lbl === 'parar' ||
      lbl === 'interromper' ||
      lbl.startsWith('stop generat') ||
      lbl.startsWith('cancel generat') ||
      lbl.startsWith('parar gera') ||
      lbl.startsWith('parar de gera') ||
      lbl.startsWith('interromper gera') ||
      lbl.startsWith('interromper a gera') ||
      lbl.startsWith('cancelar gera') ||
      lbl.startsWith('cancelar a gera')
    );
  }

  function findStopButton() {
    const container = findComposerAnchor();

    // 1. Check inside composer first (authoritative location of Send vs Stop button)
    if (container) {
      const btns = Array.from(container.querySelectorAll('button')).filter(
        (b) => !b.closest('#arena-ultra-root') && !b.closest('#arena-ultra-toolbar-host')
      );
      let hasIdleSendButton = false;

      for (const b of btns) {
        if (!isElementDisplayed(b)) continue;
        const aria = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        const text = (b.innerText || '').trim();
        const ariaLow = aria.toLowerCase();

        // Match Stop button EVEN when disabled during session compaction ("Can't stop while the conversation is compacting")!
        if (
          isTrueStopGenerationLabel(aria) ||
          isTrueStopGenerationLabel(text) ||
          ariaLow.includes('while the conversation is compacting') ||
          ariaLow.includes('enquanto a conversa')
        ) {
          return b;
        }
        if (
          ariaLow === 'send message' ||
          ariaLow === 'enviar mensagem' ||
          Boolean(b.querySelector('svg path[d*="M3 12L21 12"]'))
        ) {
          hasIdleSendButton = true;
        }
      }

      // If the composer explicitly renders the Send message arrow button ("→") and no Stop button matched above, Arena is 100% idle!
      if (hasIdleSendButton) {
        return null;
      }

      // Strict single-square SVG fallback inside composer only (excludes comboboxes, popovers, and multi-path icons like ⊞+ / ❐)
      for (const b of btns) {
        if (!isVisible(b) || b.disabled) continue;
        if (b.getAttribute('role') === 'combobox' || b.hasAttribute('aria-haspopup')) continue;
        const aria = (b.getAttribute('aria-label') || '').trim();
        if (aria) continue;
        const svg = b.querySelector('svg');
        if (svg && svg.children && svg.children.length === 1 && svg.children[0].tagName.toLowerCase() === 'rect') {
          const rectSvg = svg.children[0];
          const w = Number(rectSvg.getAttribute('width') || 0);
          const h = Number(rectSvg.getAttribute('height') || 0);
          if (w >= 6 && w <= 18 && w === h) return b;
        }
      }
      return null;
    }

    // 2. Fallback if composer is unmounted: check exact Stop generating / compacting aria-labels
    const allBtns = document.querySelectorAll('main button[aria-label], form button[aria-label]');
    for (let i = 0; i < allBtns.length; i++) {
      const btn = allBtns[i];
      if (!isVisible(btn)) continue;
      const lbl = btn.getAttribute('aria-label') || '';
      if (isTrueStopGenerationLabel(lbl) || lbl.toLowerCase().includes('while the conversation is compacting')) {
        return btn;
      }
    }
    return null;
  }

  function isSavedConversationUrl() {
    return (
      /\/(c|agent|chat|s|t|session|sessions|thread|threads|project|projects)\/[a-zA-Z0-9_-]{3,}/i.test(
        location.pathname
      ) || /[?&](id|session|chat|c|thread)=[a-zA-Z0-9_-]+/i.test(location.search)
    );
  }

  function hasConversationHistoryInDom() {
    if (isSavedConversationUrl()) return true;
    if (findTaskReviewPanel()) return true;
    try {
      const blocks = document.querySelectorAll(
        'main [data-message-author-role], main [data-message-id], main .prose, main article, main [class*="markdown"]'
      );
      for (let i = 0; i < blocks.length; i++) {
        const el = blocks[i];
        if (el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host')) continue;
        if ((el.textContent || '').trim().length > 8) return true;
      }
    } catch (_) {}
    return false;
  }

  function getComposerDraftText() {
    const el = findChatInput();
    if (!el) return '';
    const raw = el.value !== undefined ? el.value : (el.innerText || '');
    return String(raw).replace(/\u200B/g, '').trim();
  }

  function sampleChatContentGrowth() {
    if (!runtime.autoContinueEnabled && !runtime.githubActive && !runtime.pendingReloadPrompt) return;
    try {
      const main = document.querySelector('main') || document.body;
      if (!main) return;
      // O(1) tail length check: inspect ONLY the last 2 message nodes instead of concatenating all 500KB+ of <main>!
      const msgs = main.querySelectorAll('[data-message-author-role], [data-testid*="message" i], article, .prose');
      let tailLen = msgs.length * 17;
      for (let i = Math.max(0, msgs.length - 2); i < msgs.length; i++) {
        tailLen += (msgs[i].textContent || '').length;
      }
      if (msgs.length === 0) {
        const lastChild = main.lastElementChild;
        tailLen = lastChild ? (lastChild.textContent || '').length : 0;
      }
      if (runtime.lastObservedMainChars < 0) {
        runtime.lastObservedMainChars = tailLen;
        return;
      }
      if (Math.abs(tailLen - runtime.lastObservedMainChars) >= 3) {
        runtime.lastObservedMainChars = tailLen;
        const now = Date.now();
        runtime.lastContentGrowthAt = now;
        if (now - runtime.lastSendAt > 800) {
          runtime.sawActivitySinceLastSend = true;
        }
      }
    } catch (_) {}
  }

  async function setInputValueCleanly(inputEl, text) {
    const res = await sendBridgeCommand('set_text', text, 3500);
    if (res && res.ok) return true;

    const el = inputEl || findChatInput();
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return true;
    }
    return false;
  }

  async function directIsolatedSubmitFallback(cleanPrompt) {
    // 1. Dismiss Task Review Panel ("Esta tarefa foi bem-sucedida?") if still mounted
    const rev = findTaskReviewPanel();
    if (rev && (rev.keepWorkingBtn || rev.closeBtn)) {
      try {
        if (toolbarHost && toolbarHost.isConnected) toolbarHost.remove();
      } catch (_) {}
      try {
        (rev.keepWorkingBtn || rev.closeBtn).click();
      } catch (_) {}
      await bgSafeSleep(320);
    }

    // 2. Wait for chat input (.tiptap / ProseMirror / textarea)
    let editor = null;
    for (let i = 0; i < 20; i++) {
      editor = findChatInput();
      if (editor) break;
      await bgSafeSleep(150);
    }
    if (!editor) return false;

    // 3. Populate editor via native browser execCommand('insertText') (directly observed by ProseMirror!)
    try {
      editor.focus();
      if (editor.isContentEditable) {
        document.execCommand('selectAll', false, null);
        const inserted = document.execCommand('insertText', false, cleanPrompt);
        if (!inserted || !getComposerDraftText()) {
          editor.textContent = cleanPrompt;
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: cleanPrompt }));
        }
      } else {
        const proto =
          editor.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(editor, cleanPrompt);
        else editor.value = cleanPrompt;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {
      return false;
    }

    // 4. Find enabled Send button inside composer and click!
    const anchor = findComposerAnchor(editor) || editor.closest('form') || document;
    for (let w = 0; w < 22; w++) {
      await bgSafeSleep(100);
      const btns = Array.from(anchor.querySelectorAll('button')).filter(
        (b) => !b.closest('#arena-ultra-root') && !b.closest('#arena-ultra-toolbar-host') && isElementDisplayed(b)
      );
      const sendBtn =
        btns.find((b) => {
          const l = ((b.getAttribute('aria-label') || b.getAttribute('title') || '') + ' ' + (b.innerText || ''))
            .toLowerCase()
            .trim();
          return (
            !b.disabled &&
            b.getAttribute('aria-disabled') !== 'true' &&
            (b.type === 'submit' ||
              l.includes('send message') ||
              l === 'send' ||
              l.includes('enviar') ||
              l.includes('submit'))
          );
        }) ||
        btns
          .filter((b) => {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
            const l = (b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
            if (
              l.includes('add') ||
              l.includes('attach') ||
              l.includes('file') ||
              l.includes('arquivo') ||
              l.includes('anex') ||
              l.includes('model') ||
              l.includes('mic') ||
              l.includes('voice') ||
              isTrueStopGenerationLabel(l)
            ) {
              return false;
            }
            return Boolean(b.querySelector('svg'));
          })
          .pop();

      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        return true;
      }
    }
    return false;
  }

  // --- Automatic / System Prompt Firewall & Clean Live Chat DOM Filter (v3.2.2) ---
  const AUTO_PROMPT_FPS_STORAGE_KEY = '__au_auto_prompt_fps_v1__';
  const autoSentPromptKeys = (() => {
    try {
      const raw = sessionStorage.getItem(AUTO_PROMPT_FPS_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.length > 0) : []);
    } catch (_) {
      return new Set();
    }
  })();

  function recordAutoSentPromptKey(promptText, sourceLabel) {
    if (!promptText) return;
    // Do not hide a plain manual prompt or a non-collab Turn-1 user prompt ("multi_agent_init" without collab wrapper)
    if (sourceLabel === 'manual' || sourceLabel === 'manual_insert' || sourceLabel === 'broadcast') return;
    if (
      sourceLabel === 'multi_agent_init' &&
      !(AU_DEFAULTS && AU_DEFAULTS.isSystemOrAutoPromptText && AU_DEFAULTS.isSystemOrAutoPromptText(promptText))
    ) {
      return;
    }
    const norm =
      AU_DEFAULTS && typeof AU_DEFAULTS.normalizePromptKey === 'function'
        ? AU_DEFAULTS.normalizePromptKey(promptText)
        : String(promptText).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!norm || norm.length < 4) return;
    autoSentPromptKeys.add(norm);
    try {
      const arr = Array.from(autoSentPromptKeys).slice(-60);
      sessionStorage.setItem(AUTO_PROMPT_FPS_STORAGE_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  function getKnownAutoPromptsList() {
    const out = [];
    if (settings && settings.fixedContinuePrompt) out.push(settings.fixedContinuePrompt);
    if (runtime && runtime.customFixedPrompt) out.push(runtime.customFixedPrompt);
    if (settings && Array.isArray(settings.conditionalRules)) {
      for (let i = 0; i < settings.conditionalRules.length; i++) {
        const r = settings.conditionalRules[i];
        if (r && r.responsePrompt) out.push(r.responsePrompt);
      }
    }
    return out;
  }

  function isAutoOrSystemPromptText(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (
      AU_DEFAULTS &&
      typeof AU_DEFAULTS.isSystemOrAutoPromptText === 'function' &&
      AU_DEFAULTS.isSystemOrAutoPromptText(raw, getKnownAutoPromptsList())
    ) {
      return true;
    }
    const norm =
      AU_DEFAULTS && typeof AU_DEFAULTS.normalizePromptKey === 'function'
        ? AU_DEFAULTS.normalizePromptKey(raw)
        : raw.replace(/\s+/g, ' ').trim().toLowerCase();
    return Boolean(norm && autoSentPromptKeys.has(norm));
  }

  function isComposerElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    return Boolean(el.closest('[contenteditable="true"], .ProseMirror, .tiptap, .editor-content, textarea, form'));
  }

  function isUserMessageElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const roleAttr = (el.getAttribute('data-message-author-role') || '').toLowerCase();
    if (roleAttr === 'user') return true;
    if (el.hasAttribute('data-user-message-layout') || el.hasAttribute('data-user-message-body-row')) return true;
    if (el.closest('[data-user-message-layout], [data-user-message-body-row], [data-message-author-role="user"]')) {
      return true;
    }
    const cls = (el.className || '').toString();
    if (/\b(?:user-message|from-user)\b/i.test(cls)) return true;
    if (el.closest('.bg-surface-raised.ms-auto')) return true;
    return false;
  }

  function ensureCleanChatStylesInjected() {
    if (!document.head && !document.documentElement) return;
    let styleEl = document.getElementById('au-clean-chat-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'au-clean-chat-style';
      styleEl.textContent = `
        html:not([data-au-show-autoprompts="1"]) [data-agent-transcript-message][data-au-auto-prompt="hidden"],
        html:not([data-au-show-autoprompts="1"]) [data-user-message-layout][data-au-auto-prompt="hidden"],
        html:not([data-au-show-autoprompts="1"]) [data-message-author-role="user"][data-au-auto-prompt="hidden"] {
          display: none !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        html:not([data-au-show-autoprompts="1"]) [data-user-message-layout][data-au-auto-prompt="turn1-objective"] > [data-user-message-body-row] {
          display: none !important;
        }
        html:not([data-au-show-autoprompts="1"]) [data-user-message-layout][data-au-auto-prompt="turn1-objective"]::after {
          content: attr(data-au-clean-objective);
          display: block;
          width: fit-content;
          max-width: min(70%, 768px);
          margin-inline-start: auto;
          padding: 8px 12px;
          border-radius: 0.5rem;
          background: var(--surface-raised, rgba(128, 128, 138, 0.14));
          color: var(--text-primary, inherit);
          font-size: 0.95rem;
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-word;
        }
        html[data-au-auto-sending="1"] .editor-content,
        html[data-au-auto-sending="1"] .ProseMirror {
          max-height: 40px !important;
          overflow: hidden !important;
          opacity: 0.01 !important;
          pointer-events: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(styleEl);
    }
    syncCleanChatVisibilityAttr();
  }

  function syncCleanChatVisibilityAttr() {
    if (!document.documentElement) return;
    if (settings && settings.hideAutoPromptsInChat === false) {
      document.documentElement.setAttribute('data-au-show-autoprompts', '1');
    } else {
      document.documentElement.removeAttribute('data-au-show-autoprompts');
    }
  }

  function applyCleanChatAutoPromptFilter() {
    ensureCleanChatStylesInjected();
    const main = document.querySelector('main') || document.body;
    if (!main) return;

    const userLayouts = main.querySelectorAll(
      '[data-user-message-layout]:not([data-au-checked="1"]), [data-message-author-role="user"]:not([data-au-checked="1"])'
    );
    for (let i = 0; i < userLayouts.length; i++) {
      const uEl = userLayouts[i];
      if (uEl.closest('#arena-ultra-root') || uEl.closest('#arena-ultra-toolbar-host') || isComposerElement(uEl)) {
        continue;
      }
      const txt = (uEl.textContent || '').trim();
      if (!txt) continue;

      const outerRow = uEl.closest('[data-agent-transcript-message]');
      // Do not hide a row currently showing an inline Arena error/Retry alert so v3.2.1 retry can click it!
      if (outerRow && outerRow.querySelector('[role="alert"], [class*="destructive" i]')) {
        continue;
      }

      uEl.setAttribute('data-au-checked', '1');
      if (!isAutoOrSystemPromptText(txt)) continue;

      const cleanTurn1Objective =
        AU_DEFAULTS && typeof AU_DEFAULTS.extractCleanObjectiveFromAutoPrompt === 'function'
          ? AU_DEFAULTS.extractCleanObjectiveFromAutoPrompt(txt)
          : '';

      if (cleanTurn1Objective && uEl.hasAttribute('data-user-message-layout')) {
        uEl.setAttribute('data-au-clean-objective', cleanTurn1Objective.slice(0, 2000));
        uEl.setAttribute('data-au-auto-prompt', 'turn1-objective');
      } else {
        const hideTarget =
          outerRow && !outerRow.querySelector('.bg-surface-primary.rounded-xl') ? outerRow : uEl;
        hideTarget.setAttribute('data-au-auto-prompt', 'hidden');
      }
    }
  }

  async function injectAndSubmitPrompt(promptText, sourceLabel = 'auto', opts = {}) {
    if (runtime.sendingInProgress) return false;
    let cleanPrompt = String(promptText || '').trim();
    if (!cleanPrompt && (!Array.isArray(opts.attachments) || opts.attachments.length === 0)) return false;

    // SEC-01: Pre-send secret scrubber ensures zero raw PATs or credentials ever enter Arena prompts!
    if (AU_CRED_BROKER && typeof AU_CRED_BROKER.scrubSecrets === 'function') {
      cleanPrompt = AU_CRED_BROKER.scrubSecrets(cleanPrompt);
    } else if (AU_INTEGRATIONS && typeof AU_INTEGRATIONS.scrubSecrets === 'function') {
      cleanPrompt = AU_INTEGRATIONS.scrubSecrets(cleanPrompt);
    }

    // ARENA-03: Conversation identity guard — never send an automated turn if SPA route drifted to a different chat!
    if (opts && opts.expectedConvKey) {
      const curKey = extractConvKeyFromHref(location.href);
      if (curKey && curKey !== opts.expectedConvKey) {
        return false;
      }
    }

    // UX-06 / ARENA-11: Loop & token budget guard on automated sends
    const isRetry = Boolean(opts && opts.isRetry);
    if (!isRetry && sourceLabel !== 'manual' && sourceLabel !== 'manual_insert' && sourceLabel !== 'multi_agent_init') {
      const maxLoops = Number(settings.maxLoopsPerTask || 0);
      if (maxLoops > 0 && runtime.loopsCount >= maxLoops) {
        runtime.autoContinueEnabled = false;
        runtime.status = 'needs_human';
        runtime.stopReason = `Orçamento de rodadas atingido (${runtime.loopsCount}/${maxLoops})`;
        updateWebLock();
        syncTabStateToBackground();
        renderToolbarAndDrawerStatus();
        showToast(`⏸ ${runtime.stopReason}`, 'info');
        return false;
      }
      const tokenBudget = Number(settings.tokenBudgetLimit || 0);
      if (tokenBudget > 0 && runtime.estimatedSessionTokens >= tokenBudget) {
        runtime.autoContinueEnabled = false;
        runtime.status = 'needs_human';
        runtime.stopReason = `Orçamento estimado de tokens atingido (~${runtime.estimatedSessionTokens}/${tokenBudget})`;
        updateWebLock();
        syncTabStateToBackground();
        renderToolbarAndDrawerStatus();
        showToast(`⏸ ${runtime.stopReason}`, 'info');
        return false;
      }
    }

    runtime.lastAttemptedPrompt = cleanPrompt;
    runtime.lastAttemptedSource = sourceLabel;
    recordAutoSentPromptKey(cleanPrompt, sourceLabel);

    if (detectSecurityVerificationOnPage()) {
      await enterCaptchaWaitingState(cleanPrompt, sourceLabel);
      return 'captcha_waiting';
    }

    const reviewPanel = findTaskReviewPanel();
    const inputEl = findChatInput();
    if (!inputEl && !reviewPanel) return false;

    // Re-check true token limit before sending
    if (settings.hardStopOnTokenLimit && sourceLabel !== 'manual') {
      const limitHit = detectTokenLimitOnPage();
      if (limitHit) {
        triggerImmediateTokenStop(limitHit);
        return false;
      }
    }

    runtime.sendingInProgress = true;
    runtime.sendingStartedAt = Date.now();
    runtime.status = 'waiting_send';
    renderToolbarAndDrawerStatus();

    const maskAutoPromptInComposer =
      settings.hideAutoPromptsInChat !== false && isAutoOrSystemPromptText(cleanPrompt);
    if (maskAutoPromptInComposer && document.documentElement) {
      document.documentElement.setAttribute('data-au-auto-sending', '1');
    }

    try {
      // Pre-click "Continuar trabalhando" if Task Review Panel is replacing the composer
      if (reviewPanel && (reviewPanel.keepWorkingBtn || reviewPanel.closeBtn)) {
        try {
          if (toolbarHost && toolbarHost.isConnected) toolbarHost.remove();
        } catch (_) {}
        try {
          (reviewPanel.keepWorkingBtn || reviewPanel.closeBtn).click();
        } catch (_) {}
        await bgSafeSleep(220);
      }

      const bridgeExtra =
        opts && Array.isArray(opts.attachments) && opts.attachments.length > 0
          ? { attachments: opts.attachments }
          : {};
      const bridgeRes = await sendBridgeCommand('set_and_submit', cleanPrompt, 8500, bridgeExtra);
      if (document.documentElement) document.documentElement.removeAttribute('data-au-auto-sending');
      applyCleanChatAutoPromptFilter();

      if (bridgeRes && bridgeRes.captchaTriggered) {
        runtime.sendingInProgress = false;
        await enterCaptchaWaitingState(cleanPrompt, sourceLabel);
        return 'captcha_waiting';
      }
      if (bridgeRes && bridgeRes.transientError) {
        runtime.lastSendAt = Date.now();
        runtime.sawActivitySinceLastSend = false;
        runtime.lastTransientErrorAt = Date.now();
        runtime.lastTransientErrorReason = bridgeRes.reason || 'Failed to start session';
        return 'transient_error';
      }
      if (!bridgeRes || !bridgeRes.ok) {
        const fallbackOk = await directIsolatedSubmitFallback(cleanPrompt);
        if (!fallbackOk) {
          return false;
        }
      }
      applyCleanChatAutoPromptFilter();

      const watchSteps = sourceLabel === 'multi_agent_init' ? 13 : 6;
      for (let w = 0; w < watchSteps; w++) {
        await bgSafeSleep(200);
        if (detectSecurityVerificationOnPage()) {
          runtime.sendingInProgress = false;
          await enterCaptchaWaitingState(cleanPrompt, sourceLabel);
          return 'captcha_waiting';
        }
        if (w >= 4 && (Boolean(findStopButton()) || location.pathname.includes('/c/'))) {
          break;
        }
      }

      runtime.lastSendAt = Date.now();
      runtime.boundConvKey = extractConvKeyFromHref(location.href) || runtime.boundConvKey;
      if (sourceLabel === 'multi_agent_init') {
        runtime.initialLaunchSentAt = runtime.lastSendAt;
      }
      runtime.sawActivitySinceLastSend = false;
      runtime.justEnabledReadyToFire = false;
      if (!runtime.initialSessionPrompt && cleanPrompt) {
        runtime.initialSessionPrompt = cleanPrompt;
        try {
          chrome.runtime.sendMessage({ type: 'AU_REMEMBER_INITIAL_PROMPT', prompt: cleanPrompt });
        } catch (_) {}
      }
      if (isRefuseThinkingActive()) {
        startFastThinkingWatchWindow(48000);
      }

      if (sourceLabel !== 'manual_insert' && !isRetry) {
        runtime.loopsCount += 1;
        const pTok = AU_STORAGE.estimateTokens(cleanPrompt);
        runtime.estimatedSessionTokens += pTok;
        runtime.status = 'generating';
        try {
          chrome.runtime.sendMessage({
            type: 'AU_RECORD_LOOP_SENT',
            loopsCount: runtime.loopsCount,
            promptTokens: pTok,
            outputTokens: 0,
            source: sourceLabel,
            promptPreview: cleanPrompt.slice(0, 100),
            tabTitle: document.title,
            url: location.href
          });
        } catch (_) {}
      } else if (isRetry) {
        runtime.status = 'generating';
      }

      syncTabStateToBackground();
      renderToolbarAndDrawerStatus();
      return true;
    } finally {
      if (document.documentElement) {
        document.documentElement.removeAttribute('data-au-auto-sending');
      }
      bgSafeSleep(350).then(() => {
        runtime.sendingInProgress = false;
      });
    }
  }

  // ARENA-02: DOM-clone extraction stripping <details>, hidden reasoning blocks, and <thought> tags (0ms layout reflow!)
  function extractCleanElementText(el, isAssistant = true, useLayoutInnerText = false) {
    if (!el) return '';
    if (isAssistant && AU_ARENA_ADAPTER && typeof AU_ARENA_ADAPTER.extractCleanTurnText === 'function') {
      const res = AU_ARENA_ADAPTER.extractCleanTurnText(el);
      if (res && typeof res.text === 'string') {
        if (res.removedBlocks > 0) {
          runtime.filteredReasoningBlocks = Math.max(runtime.filteredReasoningBlocks || 0, res.removedBlocks);
        }
        return res.text.trim();
      }
    }
    const raw = (useLayoutInnerText ? (el.innerText || el.textContent || '') : (el.textContent || '')).trim();
    if (isAssistant && AU_INTEGRATIONS && typeof AU_INTEGRATIONS.scrubReasoningBlocks === 'function') {
      return AU_INTEGRATIONS.scrubReasoningBlocks(raw).text;
    }
    return raw;
  }

  // --- Extract Conversation Messages from Arena Page ---
  function scrapeConversationMessages(useLayoutInnerText = false) {
    const messages = [];
    const main = document.querySelector('main') || document.body;
    const allCandidates = Array.from(
      main.querySelectorAll('[data-user-message-layout], [data-message-author-role], [data-testid*="message" i], article, .prose')
    ).filter((el) => {
      if (el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host')) return false;
      if (isComposerElement(el)) return false;
      if (
        el.classList &&
        el.classList.contains('prose') &&
        el.parentElement &&
        el.parentElement.closest('[data-user-message-layout], [data-message-author-role], [data-testid*="message" i], article')
      ) {
        return false;
      }
      return true;
    });

    const sliceStart = useLayoutInnerText ? 0 : Math.max(0, allCandidates.length - 50);
    const seenTexts = new Set();
    for (let i = sliceStart; i < allCandidates.length; i++) {
      const el = allCandidates[i];
      const isUser = isUserMessageElement(el);
      let txt = extractCleanElementText(el, !isUser, useLayoutInnerText);
      if (!txt || txt.length < 2) continue;

      if (isUser && isAutoOrSystemPromptText(txt)) {
        const cleanObj =
          AU_DEFAULTS && typeof AU_DEFAULTS.extractCleanObjectiveFromAutoPrompt === 'function'
            ? AU_DEFAULTS.extractCleanObjectiveFromAutoPrompt(txt)
            : '';
        if (cleanObj) {
          txt = cleanObj;
        } else {
          continue;
        }
      }

      const fp = `${txt.length}:${txt.slice(0, 120)}`;
      if (seenTexts.has(fp)) continue;
      seenTexts.add(fp);

      messages.push({
        role: isUser ? 'user' : 'assistant',
        content: useLayoutInnerText ? txt : txt.slice(0, 18000)
      });
    }

    if (messages.length === 0) {
      const rawBody = extractCleanElementText(main, true, useLayoutInnerText);
      if (rawBody && !isAutoOrSystemPromptText(rawBody)) {
        messages.push({ role: 'assistant', content: rawBody.slice(0, 20000) });
      }
    }
    return messages;
  }

  function getLastUserMessageElement(main) {
    const root = main || document.querySelector('main') || document.body;
    if (!root) return null;
    const nodes = root.querySelectorAll(
      '[data-user-message-layout], [data-user-message-body-row], [data-message-author-role="user"], .bg-surface-raised.ms-auto'
    );
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      if (el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host') || isComposerElement(el)) {
        continue;
      }
      return el;
    }
    return null;
  }

  // Multi-block assistant turn reader: captures ALL assistant prose blocks emitted after lastUserEl across intermediate tool cards!
  function getLastAssistantText(fastNoLayout = false, onlyAfterLastUser = false) {
    const main = document.querySelector('main') || document.body;
    if (!main) return '';
    const lastUserEl = onlyAfterLastUser ? getLastUserMessageElement(main) : null;
    const candidates = main.querySelectorAll('[data-message-author-role], [data-testid*="message" i], article, .prose');
    const collectedBlocks = [];
    const seenFingerprints = new Set();

    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host')) continue;
      if (el.closest('details, summary')) continue;
      if (isComposerElement(el) || isUserMessageElement(el)) continue;
      // Avoid double-reading inner .prose when an outer assistant message wrapper is also in candidates
      if (
        el.classList &&
        el.classList.contains('prose') &&
        el.parentElement &&
        el.parentElement.closest('[data-message-author-role], [data-testid*="message" i], article, .prose')
      ) {
        continue;
      }
      if (
        lastUserEl &&
        typeof lastUserEl.compareDocumentPosition === 'function' &&
        !(lastUserEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      ) {
        break;
      }
      const txt = extractCleanElementText(el, true, !fastNoLayout);
      if (txt.length < 2) continue;
      if (isAutoOrSystemPromptText(txt)) continue;

      if (!onlyAfterLastUser) {
        return txt;
      }
      const fp = `${txt.length}:${txt.slice(0, 96)}:${txt.slice(-48)}`;
      if (!seenFingerprints.has(fp)) {
        seenFingerprints.add(fp);
        collectedBlocks.push(txt);
      }
      if (collectedBlocks.length >= 24) break;
    }

    if (collectedBlocks.length > 0) {
      return collectedBlocks.reverse().join('\n\n');
    }
    return '';
  }

  // --- Security Verification (reCAPTCHA) Detection & Automatic Post-Check Resume ---
  function isTrulyVisibleChallengeFrame(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('.grecaptcha-badge') || el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host')) {
      return false;
    }
    let cur = el;
    for (let d = 0; d < 10 && cur && cur.nodeType === 1; d++) {
      const st = window.getComputedStyle(cur);
      if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') return false;
      if (Number(st.opacity) <= 0.05) return false;
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 2560;
    const vh = window.innerHeight || 1440;
    return r.width > 0 && r.height > 0 && r.left >= -5 && r.top >= -5 && r.left < vw && r.top < vh;
  }

  function detectSecurityVerificationOnPage() {
    try {
      // 1. Check ONLY real modal dialogs ([role="dialog"] / [role="alertdialog"]) — NEVER [data-state="open"] or body.innerText!
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(
        (d) =>
          d.isConnected &&
          !d.closest('#arena-ultra-root') &&
          !d.closest('#arena-ultra-toolbar-host') &&
          !d.closest('[data-message-author-role], article, .prose') &&
          isElementDisplayed(d)
      );
      for (const d of dialogs) {
        const st = window.getComputedStyle(d);
        if (Number(st.opacity) <= 0.05 || st.pointerEvents === 'none') continue;
        const dr = d.getBoundingClientRect();
        if (dr.width < 200 || dr.height < 100) continue;

        const modalText = (d.innerText || '').trim().toLowerCase();
        if (
          modalText.length > 0 &&
          modalText.length < 500 &&
          (modalText.includes('security verification') ||
            modalText.includes('complete this quick security check') ||
            modalText.includes('verificação de segurança'))
        ) {
          return true;
        }

        const frames = Array.from(
          d.querySelectorAll(
            'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]'
          )
        );
        for (const f of frames) {
          if (isTrulyVisibleChallengeFrame(f)) {
            const fr = f.getBoundingClientRect();
            if (fr.width >= 160 && fr.height >= 45) return true;
          }
        }
      }

      // 2. Active Google reCAPTCHA image-grid challenge popup (bframe) — only when genuinely visible & interactive!
      const bframes = Array.from(
        document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]')
      );
      for (const f of bframes) {
        if (isTrulyVisibleChallengeFrame(f)) {
          const r = f.getBoundingClientRect();
          if (r.width >= 280 && r.height >= 350 && r.left >= 0 && r.top >= 0) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  let captchaWatcherActive = false;

  async function enterCaptchaWaitingState(pendingPrompt, sourceLabel = 'auto') {
    const wasAlreadyWaiting = runtime.status === 'captcha_waiting';
    if (pendingPrompt) {
      runtime.pendingCaptchaPrompt = pendingPrompt;
      runtime.pendingCaptchaSource = sourceLabel;
    }
    runtime.status = 'captcha_waiting';
    runtime.stopReason = 'Aguardando marcação do "Não sou um robô"';
    syncTabStateToBackground();
    renderToolbarAndDrawerStatus();

    if (!wasAlreadyWaiting) {
      try {
        chrome.runtime.sendMessage({ type: 'AU_FOCUS_CAPTCHA_TAB' });
      } catch (_) {}
      showToast('🛡️ Marque "Não sou um robô" sem pressa — a fila espera você terminar!', 'info');
    }

    if (captchaWatcherActive) return;
    captchaWatcherActive = true;

    try {
      // Poll up to 10 minutes waiting for user to complete Security Verification at their own pace
      for (let i = 0; i < 850; i++) {
        if (!isCurrentInstance()) return;
        await bgSafeSleep(700);
        if (!detectSecurityVerificationOnPage()) {
          // Wait 1.8s and re-check so if Google transitions from checkbox to image grid (bframe), we keep waiting!
          await bgSafeSleep(1800);
          if (detectSecurityVerificationOnPage()) {
            continue;
          }

          const alreadyStreaming =
            (runtime.netActiveStreams > 0 && Date.now() - runtime.lastNetChunkAt < 8000) ||
            Boolean(findStopButton()) ||
            (sourceLabel === 'multi_agent_init' && location.pathname.includes('/c/'));

          if (alreadyStreaming) {
            runtime.loopsCount += 1;
            runtime.status = 'generating';
            runtime.stopReason = '';
            runtime.pendingCaptchaPrompt = '';
            syncTabStateToBackground();
            renderToolbarAndDrawerStatus();
            if (runtime.pendingLaunchJobId) {
              const doneId = runtime.pendingLaunchJobId;
              runtime.pendingLaunchJobId = null;
              try {
                chrome.runtime.sendMessage({ type: 'AU_CONFIRM_JOB_STARTED', jobId: doneId });
              } catch (_) {}
            }
            showToast('Verificação concluída! Agent trabalhando.', 'success');
            return;
          }

          // Otherwise, re-submit the intercepted prompt automatically!
          const promptToFire = runtime.pendingCaptchaPrompt;
          const srcToFire = runtime.pendingCaptchaSource || 'post_captcha';
          runtime.pendingCaptchaPrompt = '';
          runtime.stopReason = '';
          if (promptToFire) {
            const res = await injectAndSubmitPrompt(promptToFire, srcToFire);
            if (res === true && runtime.pendingLaunchJobId) {
              const doneId = runtime.pendingLaunchJobId;
              runtime.pendingLaunchJobId = null;
              try {
                chrome.runtime.sendMessage({ type: 'AU_CONFIRM_JOB_STARTED', jobId: doneId });
              } catch (_) {}
            }
            if (res === true) {
              showToast('Verificação concluída! Tarefa iniciada automaticamente.', 'success');
            }
          }
          return;
        }
      }
    } finally {
      captchaWatcherActive = false;
    }
  }

  // --- Token Exhaustion Detection & Alerts ---
  function detectTokenLimitOnPage() {
    // NEVER confuse Security Verification / reCAPTCHA with Token Exhaustion!
    if (detectSecurityVerificationOnPage()) {
      return null;
    }

    const patterns = Array.isArray(settings.tokenLimitPatterns) && settings.tokenLimitPatterns.length
      ? settings.tokenLimitPatterns
      : AU_DEFAULTS.DEFAULT_TOKEN_LIMIT_PATTERNS;

    // Single combined query using layout-free textContent before visibility filtering
    const candidates = document.querySelectorAll(
      '[role="alert"], [data-sonner-toast], [class*="toast" i], [class*="error" i], [class*="banner" i], [class*="limit" i]'
    );

    const textsToCheck = [];
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const raw = (el.textContent || '').trim();
      if (!raw || raw.length >= 800) continue;
      if (
        el.closest('#arena-ultra-root') ||
        el.closest('#arena-ultra-toolbar-host') ||
        el.closest('[data-message-author-role], article, .prose') ||
        !isVisible(el)
      ) {
        continue;
      }
      textsToCheck.push(raw.toLowerCase());
    }

    const composerArea = findComposerAnchor();
    if (composerArea) {
      const compTxt = (composerArea.textContent || '').trim();
      if (compTxt && compTxt.length < 600) textsToCheck.push(compTxt.toLowerCase());
      // Live Arena.ai composer sets aria-disabled="true" + title="Out of credits" on the Send button when ew.isBlocked is true!
      const titledBtns = composerArea.querySelectorAll('button[aria-disabled="true"], button[title]');
      for (let k = 0; k < titledBtns.length; k++) {
        const b = titledBtns[k];
        if (b.closest('#arena-ultra-root') || b.closest('#arena-ultra-toolbar-host') || !isElementDisplayed(b)) {
          continue;
        }
        const tAttr = (b.getAttribute('title') || '').trim();
        if (tAttr && tAttr.length < 240) {
          textsToCheck.push(tAttr.toLowerCase());
        }
      }
    }

    const combined = textsToCheck.join('\n');
    for (const pat of patterns) {
      const cleanPat = String(pat || '').trim().toLowerCase();
      if (cleanPat && combined.includes(cleanPat)) {
        return `Detectado: "${pat}"`;
      }
    }
    return null;
  }

  function playAlertChime() {
    if (!settings.soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      const notes = [587.33, 440.0, 587.33]; // D5 -> A4 -> D5 distinct alert chime
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.16);
        gain.gain.setValueAtTime(0.001, now + idx * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.18, now + idx * 0.16 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.16 + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.16);
        osc.stop(now + idx * 0.16 + 0.16);
      });
      setTimeout(() => {
        try {
          if (typeof ctx.close === 'function') ctx.close().catch(() => {});
        } catch (_) {}
      }, 900);
    } catch (_) {}
  }

  function startBlinkingTabTitle() {
    if (!settings.blinkTabTitle) return;
    stopBlinkingTabTitle();
    runtime.originalTitle = document.title.replace(/^⚠️ \[SEM TOKENS\]\s*/, '') || 'Arena.ai';
    let toggle = false;
    runtime.blinkTimer = setInterval(() => {
      toggle = !toggle;
      document.title = toggle ? `⚠️ [SEM TOKENS] ${runtime.originalTitle}` : runtime.originalTitle;
    }, 1100);

    const clearOnFocus = () => {
      stopBlinkingTabTitle();
      window.removeEventListener('mousedown', clearOnFocus);
    };
    window.addEventListener('mousedown', clearOnFocus, { once: true });
  }

  function stopBlinkingTabTitle() {
    if (runtime.blinkTimer) {
      clearInterval(runtime.blinkTimer);
      runtime.blinkTimer = null;
      if (runtime.originalTitle) {
        document.title = runtime.originalTitle;
      }
    }
  }

  function triggerImmediateTokenStop(reasonText) {
    if (runtime.status === 'token_stopped' && !runtime.autoContinueEnabled) return;
    runtime.autoContinueEnabled = false;
    runtime.status = 'token_stopped';
    runtime.stopReason = reasonText || 'Limite de tokens/uso atingido';
    updateWebLock();
    playAlertChime();
    startBlinkingTabTitle();
    showToast(`Autopilot parado: ${runtime.stopReason}`, 'error');

    // Auto-save snapshot immediately on stop so zero progress is lost
    if (settings.autoSaveSnapshots) {
      autoSaveCurrentConversationSnapshot();
    }

    try {
      chrome.runtime.sendMessage({
        type: 'AU_TOKEN_LIMIT_STOP',
        report: {
          reason: runtime.stopReason,
          loopsCount: runtime.loopsCount,
          tabTitle: runtime.originalTitle || document.title,
          url: location.href
        }
      });
    } catch (_) {}

    syncTabStateToBackground();
    renderToolbarAndDrawerStatus();
  }

  // --- Choose Next Auto-Continue Prompt (Fixed / Queue / Smart Rules / Hybrid) ---
  const compiledRuleCache = new Map();
  function getCompiledRuleRegex(pattern) {
    let rx = compiledRuleCache.get(pattern);
    if (!rx) {
      rx = new RegExp(pattern, 'i');
      if (compiledRuleCache.size > 64) compiledRuleCache.clear();
      compiledRuleCache.set(pattern, rx);
    }
    return rx;
  }

  function selectNextContinuePrompt() {
    const strat = runtime.strategy || settings.autoContinueStrategy || 'hybrid';

    // 1. Smart Conditional Rules
    if (strat === 'conditional' || strat === 'hybrid') {
      const lastReply = getLastAssistantText().slice(-3000);
      const rules = Array.isArray(settings.conditionalRules) ? settings.conditionalRules : [];
      for (const r of rules) {
        if (!r || !r.enabled || !r.pattern || !r.responsePrompt) continue;
        try {
          if (getCompiledRuleRegex(r.pattern).test(lastReply)) {
            return { text: r.responsePrompt, source: `regra:${r.name}` };
          }
        } catch (_) {}
      }
    }

    // 2. Sequential Prompt Queue
    if ((strat === 'queue' || strat === 'hybrid') && runtime.promptQueue.length > 0) {
      const nextStep = runtime.promptQueue.shift();
      saveToTabSessionStorage();
      return { text: nextStep, source: `fila (restam ${runtime.promptQueue.length})`, fromQueue: true, queueItem: nextStep };
    }

    // 3. Fixed Prompt (also runs after Queue finishes per Q2!)
    const fixed = (runtime.customFixedPrompt || settings.fixedContinuePrompt || '').trim();
    return {
      text: fixed || AU_DEFAULTS.DEFAULT_SETTINGS.fixedContinuePrompt,
      source: 'continuo'
    };
  }

  // =========================================================================
  // ANTI-THINKING MODEL DETECTOR, STOPPER & TEAM ADMISSION FILTER (v3.0.0)
  // Detects Arena's 3 Reasoning UI variants:
  //   1. "> Thinking..." (collapsible chevron + shimmer Thinking...)
  //   2. "🧠 Thought for 38 seconds" / "Thought for a few seconds" / "Thought for X minutes"
  //   3. "🧠 Thinking..." (brain icon + Thinking...)
  // Stops generation immediately & refuses/re-rolls until a non-Thinking model responds!
  // =========================================================================
  const THOUGHT_DURATION_RX =
    /^(?:Thought for (?:a few seconds|\d+\s*(?:second|seconds|sec|s|minute|minutes|min|m)(?:\s*(?:and|,)\s*\d+\s*(?:second|seconds|sec|s))?)|Pensou por (?:alguns segundos|\d+\s*(?:segundo|segundos|seg|s|minuto|minutos|min)(?:\s*(?:e|,)\s*\d+\s*(?:segundo|segundos|seg|s))?)|Pens[oó] durante (?:unos segundos|\d+\s*(?:segundo|segundos|minuto|minutos).*)|Raciocinou por (?:alguns segundos|\d+\s*(?:segundo|segundos|minuto|minutos).*))\.?$/i;

  const ACTIVE_THINKING_LABEL_RX = /^(?:Thinking|Pensando|Raciocinando)\.{2,3}$/i;

  function isRefuseThinkingActive() {
    if (runtime.jobRefuseThinking !== null && runtime.jobRefuseThinking !== undefined) {
      return Boolean(runtime.jobRefuseThinking);
    }
    return settings.refuseThinkingModels !== false;
  }

  function extractVisibleTextNoSvgOrCode(rootEl) {
    let out = '';
    const stack = [rootEl];
    let guard = 0;
    while (stack.length > 0 && guard < 80) {
      guard += 1;
      const node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
      } else if (node.nodeType === 1) {
        const tag = node.tagName.toUpperCase();
        if (tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'CODE' || tag === 'PRE') {
          continue;
        }
        const children = node.childNodes;
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push(children[i]);
        }
      }
    }
    return out.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
  }

  function isIgnoredForThinkingScan(el) {
    if (!el || el.nodeType !== 1) return true;
    if (
      el.closest(
        '#arena-ultra-root, #arena-ultra-toolbar-host, header, nav, aside, form, .editor-content, textarea, [contenteditable="true"], pre, code, [role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-message-author-role="user"], [data-role="user"]'
      )
    ) {
      return true;
    }
    // Exclude user prompt bubbles styled with right-aligned classes or containing our injected collaboration headers
    const bubble = el.closest('[data-message-author-role], [data-testid*="message" i], .ml-auto');
    if (bubble) {
      const role = (bubble.getAttribute('data-message-author-role') || bubble.getAttribute('data-role') || '').toLowerCase();
      if (role === 'user') return true;
      const cls = String(bubble.className || '');
      if (/\bml-auto\b/.test(cls) && !bubble.querySelector('.prose, pre, svg.lucide-brain')) return true;
    }
    return false;
  }

  function hasReasoningUiStructure(el, rawCleanText) {
    // Leading explicit chevron text e.g. "> Thinking..."
    if (/^[>›▸▾]\s*(?:Thinking|Pensando|Raciocinando)\.{2,3}$/i.test(rawCleanText)) {
      return true;
    }
    const row =
      el.closest('button, summary, [role="button"], [data-state], [aria-expanded], details') ||
      el.parentElement ||
      el;
    if (!row || row.nodeType !== 1) return false;

    // Exclude right-hand Workspace Preview status bar ("Preview will be available soon" / "Database" / "Secrets")
    const panelCtx = row.parentElement ? (row.parentElement.textContent || '') : '';
    if (
      panelCtx.includes('Preview will be available soon') ||
      (panelCtx.includes('Database') && panelCtx.includes('Secrets'))
    ) {
      return false;
    }

    // Check for Brain icon (image-2 & image-3) or Chevron / SVG icon (image-1) or Collapsible trigger
    const rowLen = (row.textContent || '').trim().length;
    if (rowLen <= 120) {
      if (row.querySelector('svg')) return true;
      if (row.parentElement && (row.parentElement.textContent || '').trim().length <= 120 && row.parentElement.querySelector('svg')) {
        return true;
      }
      const tag = row.tagName.toUpperCase();
      if (tag === 'BUTTON' || tag === 'SUMMARY' || row.hasAttribute('data-state') || row.hasAttribute('aria-expanded')) {
        return true;
      }
    }

    // Check shimmer / muted status classes used by Arena's Reasoning header
    const cls = `${el.className || ''} ${row.className || ''}`;
    if (/(?:shimmer|animate-pulse|bg-clip-text|lucide-brain|reasoning)/i.test(cls) && !el.closest('.prose p, .markdown p')) {
      return true;
    }
    return false;
  }

  function detectThinkingModelIndicator(forceScan = false) {
    // Once a specific /agent/<id> or /c/<id> session is confirmed non-Thinking, skip DOM scans forever on that chat (Arena locks model per chat!)
    if (
      !forceScan &&
      runtime.cleanConvPathConfirmed &&
      runtime.cleanConvPathConfirmed === location.pathname &&
      /\/(?:agent|c)\/[A-Za-z0-9_-]{3,}/i.test(location.pathname || '')
    ) {
      return null;
    }

    const scope = document.querySelector('main') || document.body;
    if (!scope) return null;

    // Fast targeted check 1: explicit lucide-brain SVG inside conversation area (image-2 & image-3)
    const brainSvgs = scope.querySelectorAll('svg.lucide-brain, svg[class*="brain" i]');
    for (let i = brainSvgs.length - 1; i >= 0; i--) {
      const svg = brainSvgs[i];
      const host = svg.parentElement;
      if (!host || isIgnoredForThinkingScan(host) || !isElementDisplayed(host)) continue;
      const lbl = extractVisibleTextNoSvgOrCode(host);
      const core = lbl.replace(/^[>›▸▾•\s]+/, '').trim();
      if (THOUGHT_DURATION_RX.test(core) || ACTIVE_THINKING_LABEL_RX.test(core)) {
        return core;
      }
    }

    // Check 2: O(1) bounded tail check — NEVER read textContent on large container divs (childElementCount > 4)!
    // Inspect at most the last 200 compact elements from the bottom of the conversation!
    const nodes = scope.querySelectorAll('button, summary, [role="button"], [data-state], [aria-expanded], span, div');
    const minIdx = Math.max(0, nodes.length - 220);
    for (let i = nodes.length - 1; i >= minIdx; i--) {
      const el = nodes[i];
      if (el.childElementCount > 4) continue; // Crucial O(1) guard: skips huge wrapper divs without allocating 500KB strings!
      const rawTc = el.textContent;
      if (!rawTc || rawTc.length < 7 || rawTc.length > 110) continue;
      if (
        !rawTc.includes('Thinking') &&
        !rawTc.includes('Thought for') &&
        !rawTc.includes('Pensando') &&
        !rawTc.includes('Pensou por') &&
        !rawTc.includes('Pensó') &&
        !rawTc.includes('Raciocin')
      ) {
        continue;
      }
      if (isIgnoredForThinkingScan(el) || !isElementDisplayed(el)) continue;

      const clean = extractVisibleTextNoSvgOrCode(el);
      if (!clean || clean.length < 7 || clean.length > 96) continue;
      const core = clean.replace(/^[>›▸▾•\s]+/, '').trim();

      if (THOUGHT_DURATION_RX.test(core)) {
        return core;
      }
      if (ACTIVE_THINKING_LABEL_RX.test(core) && hasReasoningUiStructure(el, clean)) {
        return core;
      }
    }

    return null;
  }

  function extractFirstUserMessageFromDom() {
    // Read raw first user bubble BEFORE clean-objective stripping so re-rolls preserve full Collab/GitHub bootstrap!
    const main = document.querySelector('main') || document.body;
    if (main) {
      const userNodes = main.querySelectorAll('[data-user-message-layout], [data-message-author-role="user"]');
      for (let i = 0; i < userNodes.length; i++) {
        if (isComposerElement(userNodes[i])) continue;
        const rawTxt = (userNodes[i].textContent || '').trim();
        if (rawTxt.length >= 2) return rawTxt;
      }
    }
    const msgs = scrapeConversationMessages();
    const firstUser = msgs.find((m) => m.role === 'user' && m.content && m.content.trim().length > 0);
    return firstUser ? firstUser.content.trim() : '';
  }

  function stopFastThinkingWatchWindow() {
    if (runtime.fastScreeningTimer) {
      clearInterval(runtime.fastScreeningTimer);
      runtime.fastScreeningTimer = null;
    }
    if (runtime.fastScreeningObserver) {
      try {
        runtime.fastScreeningObserver.disconnect();
      } catch (_) {}
      runtime.fastScreeningObserver = null;
    }
  }

  function getCurrentOrCreatedConvId() {
    const m = (location.pathname || '').match(/\/(?:agent|c|chat|s|t)\/([A-Za-z0-9_-]{3,})/i);
    if (m && m[1]) return m[1];
    return runtime.lastCreatedConvId || '';
  }

  async function exportCurrentTabWorkspacePayload(preferRepoSubdir = true) {
    try {
      await ensurePageBridgeReady(2200);
      const wsRes = await sendBridgeCommand(
        'export_workspace',
        preferRepoSubdir ? 'prefer_repo' : 'raw_workspace',
        25000
      );
      if (wsRes && wsRes.ok) {
        return wsRes;
      }
    } catch (_) {}
    return { ok: false, reason: 'workspace_unavailable' };
  }

  async function downloadCurrentTabWorkspaceAsZip(opts = {}) {
    const returnBytesOnly = Boolean(opts && opts.returnBytes);
    if (!returnBytesOnly) {
      showToast('⬇ Exportando arquivos do Workspace desta sessão...', 'info');
    }
    const wsRes = await exportCurrentTabWorkspacePayload(false);
    if (wsRes && wsRes.ok && AU_INTEGRATIONS) {
      let zipBytes = null;
      let base64Zip = '';
      if (wsRes.mode === 'zip' && wsRes.base64Zip) {
        base64Zip = wsRes.base64Zip;
        if (!returnBytesOnly) zipBytes = AU_INTEGRATIONS.base64ToUint8(wsRes.base64Zip);
      } else if (wsRes.mode === 'cas' && Array.isArray(wsRes.files) && wsRes.files.length > 0 && AU_INTEGRATIONS.buildZipArchive) {
        zipBytes = AU_INTEGRATIONS.buildZipArchive(wsRes.files);
        if (returnBytesOnly && AU_INTEGRATIONS.uint8ToBase64) {
          base64Zip = AU_INTEGRATIONS.uint8ToBase64(zipBytes);
        }
      }
      const shortId = (wsRes.convId || getCurrentOrCreatedConvId() || 'agent').slice(0, 12);
      const filename = `arena-workspace-${shortId}.zip`;
      if (returnBytesOnly && base64Zip) {
        return { ok: true, filename, base64Zip };
      }
      if (zipBytes && zipBytes.length > 0) {
        const blob = new Blob([zipBytes], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(url);
        }, 500);
        showToast('✅ Workspace (.zip) baixado com sucesso!', 'success');
        return { ok: true, filename, byteLength: zipBytes.length };
      }
    }
    const errMsg = 'Esta sessão ainda não possui arquivos salvos no Workspace (/home/user).';
    if (!returnBytesOnly) {
      showToast('⚠️ ' + errMsg, 'error');
    }
    return { ok: false, reason: 'no_workspace', error: errMsg };
  }

  async function archiveRefusedChatNow() {
    const fallbackId = getCurrentOrCreatedConvId();
    try {
      await ensurePageBridgeReady(1800);
      const archRes = await sendBridgeCommand('archive_current_chat', fallbackId, 7500);
      return {
        archived: Boolean(archRes && archRes.ok && archRes.archived),
        convId: (archRes && archRes.convId) || fallbackId || '',
        method: (archRes && archRes.method) || ''
      };
    } catch (_) {
      return { archived: false, convId: fallbackId || '', method: '' };
    }
  }

  async function stopAndRefuseThinkingModel(indicatorText) {
    if (runtime.refusingInProgress || !isCurrentInstance()) return true;
    runtime.refusingInProgress = true;
    stopFastThinkingWatchWindow();

    try {
      // Capture prompt BEFORE archiving (in case Arena's archive redirects away from the conversation!)
      const promptForReroll =
        (runtime.initialSessionPrompt || runtime.lastAttemptedPrompt || extractFirstUserMessageFromDom() || '').trim();

      // 1. Click Arena's "Stop generating" immediately so zero extra tokens/seconds are wasted!
      const stopBtn = findStopButton();
      if (stopBtn && !stopBtn.disabled) {
        try {
          stopBtn.click();
        } catch (_) {}
      }

      // 2. Clear per-tab sessionStorage snapshot so old conversation state never leaks onto fresh /agent!
      try {
        sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
      } catch (_) {}

      runtime.admittedToTeam = false;
      runtime.status = 'paused';
      runtime.stopReason = `Modelo "${indicatorText}" recusado`;
      renderToolbarAndDrawerStatus();

      showToast(`🚫 "${indicatorText}" detectado! Parando, arquivando chat e recusando modelo...`, 'error');

      // Give Arena's stop request 280ms to abort stream cleanly, then archive via direct API + sidebar fallback!
      await bgSafeSleep(280);
      const archInfo = await archiveRefusedChatNow();
      const wasArchived = archInfo.archived;

      const res = await sendBgMessage({
        type: 'AU_MODEL_THINKING_REFUSED',
        payload: {
          indicator: indicatorText,
          archived: wasArchived,
          convId: archInfo.convId || '',
          collabRoomId: runtime.collabRoomId || '',
          collabAgentName: runtime.collabAgentName || '',
          githubActive: Boolean(runtime.githubActive),
          githubRepo: runtime.githubRepo || '',
          githubBaseBranch: runtime.githubBaseBranch || '',
          githubBranch: runtime.githubBranch || '',
          initialPrompt: promptForReroll,
          autoContinueEnabled: runtime.autoContinueEnabled,
          strategy: runtime.strategy,
          fixedPrompt: runtime.customFixedPrompt,
          queue: runtime.promptQueue
        }
      });

      if (res && res.action === 'rerolling') {
        runtime.rerollAttempt = Number(res.attempt || 1);
        showToast(
          `🔄 Modelo Thinking recusado${wasArchived ? ' e arquivado' : ''} (#${runtime.rerollAttempt})! Sorteando modelo sem Thinking...`,
          'info'
        );
        // Keep refusingInProgress = true until chrome.tabs.update reloads https://arena.ai/agent
        bgSafeSleep(12000).then(() => {
          runtime.refusingInProgress = false;
        });
        return true;
      }

      // Stopped without re-roll (either auto-reroll disabled, max retries reached, or manual chat with no prompt)
      runtime.autoContinueEnabled = false;
      runtime.status = 'token_stopped';
      runtime.stopReason = (res && res.reason) || `Modelo "${indicatorText}" parado e arquivado`;
      updateWebLock();
      syncTabStateToBackground();
      renderToolbarAndDrawerStatus();
      runtime.refusingInProgress = false;
      return true;
    } catch (_) {
      runtime.refusingInProgress = false;
      return true;
    }
  }

  function startFastThinkingWatchWindow(durationMs = 45000) {
    stopFastThinkingWatchWindow();
    if (!isRefuseThinkingActive()) return;
    const started = Date.now();
    let lastObsCheckAt = 0;

    const runCheck = () => {
      if (!isCurrentInstance() || !isRefuseThinkingActive() || runtime.refusingInProgress) {
        stopFastThinkingWatchWindow();
        return;
      }
      if (Date.now() - started > durationMs) {
        stopFastThinkingWatchWindow();
        return;
      }
      const hit = detectThinkingModelIndicator();
      if (hit) {
        stopAndRefuseThinkingModel(hit);
      }
    };

    // 1. Synchronous DOM MutationObserver: fires IMMEDIATELY on SSE chunks even in background/grouped tabs (0ms throttling)!
    const targetNode = document.querySelector('main') || document.body;
    if (targetNode && typeof MutationObserver === 'function') {
      runtime.fastScreeningObserver = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastObsCheckAt < 200) return;
        lastObsCheckAt = now;
        runCheck();
      });
      runtime.fastScreeningObserver.observe(targetNode, { childList: true, subtree: true });
    }

    // 2. Interval backup for foreground tabs
    runtime.fastScreeningTimer = setInterval(runCheck, 350);
  }
  // After Chromium discards a tab under High RAM ("Muita RAM em uso") and reloads it,
  // Arena may display a "Reconnect" / "Reconectar" button if the stream broke mid-turn.
  let lastReconnectClickAt = 0;
  let reconnectClicksInRow = 0;

  function detectAndHandleArenaStreamRecovery() {
    if (findTaskReviewPanel()) {
      reconnectClicksInRow = 0;
      return false;
    }
    const root = document.querySelector('main') || document.body;
    if (!root) return false;

    const btns = root.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!isElementDisplayed(b) || b.disabled) continue;
      if (b.closest('#arena-ultra-root') || b.closest('#arena-ultra-toolbar-host')) continue;
      const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (txt === 'reconnect' || txt === 'reconectar') {
        if (reconnectClicksInRow < 2 && Date.now() - lastReconnectClickAt > 8000) {
          lastReconnectClickAt = Date.now();
          reconnectClicksInRow += 1;
          try { b.click(); } catch (_) {}
          return true;
        }
        return false;
      }
    }
    reconnectClicksInRow = 0;
    return false;
  }

  const TRANSIENT_ARENA_ERROR_RX =
    /failed to start (?:chat )?session|failed to create (?:chat|coding) (?:session|access token)|the chat did not confirm the message|retry it or reconnect|reconnect to continue this chat|the conversation status is unavailable|recover the previous message|stopped chat response cannot be matched|reload the chat before sending|this chat changed since you loaded it|stream connection retries exhausted|the assistant ran out of memory|the assistant crashed unexpectedly|the connection to the ai service was interrupted|arena took too long to respond|the ai service encountered an error|the ai took too long to respond|the tool response is malformed|message validation failed\. please refresh|falha ao iniciar (?:a )?sess[aã]o|erro ao iniciar (?:a )?sess[aã]o|erro ao criar (?:a )?sess[aã]o|sandbox failed to start/i;

  const NEEDS_PAGE_RELOAD_ERROR_RX =
    /stopped chat response cannot be matched|reload the chat before sending|this chat changed since you loaded it|the tool response is malformed|message validation failed\. please refresh/i;

  function extractLastUserMessageFromDom() {
    const main = document.querySelector('main') || document.body;
    if (!main) return '';
    const userNodes = main.querySelectorAll('[data-user-message-layout], [data-message-author-role="user"]');
    for (let i = userNodes.length - 1; i >= 0; i--) {
      if (isComposerElement(userNodes[i])) continue;
      const txt = (userNodes[i].textContent || '').trim();
      if (txt.length >= 2) return txt;
    }
    return extractFirstUserMessageFromDom();
  }

  function getTurnDomState() {
    const main = document.querySelector('main') || document.body;
    if (!main) return { userCount: 0, assistantCount: 0, lastRoleIsUser: false };

    const transcriptRows = main.querySelectorAll('[data-agent-transcript-message]');
    if (transcriptRows.length > 0) {
      let userCount = 0;
      let assistantCount = 0;
      let lastRole = '';
      for (let i = 0; i < transcriptRows.length; i++) {
        const row = transcriptRows[i];
        if (row.closest('#arena-ultra-root') || row.closest('#arena-ultra-toolbar-host')) continue;
        if (row.querySelector('[data-user-message-layout]')) {
          userCount += 1;
          lastRole = 'user';
        } else {
          const t = (row.textContent || '').trim();
          if (t.length >= 2) {
            assistantCount += 1;
            lastRole = 'assistant';
          }
        }
      }
      return { userCount, assistantCount, lastRoleIsUser: lastRole === 'user' };
    }

    const roleNodes = main.querySelectorAll('[data-message-author-role]');
    if (roleNodes.length > 0) {
      let userCount = 0;
      let assistantCount = 0;
      let lastRole = '';
      for (let i = 0; i < roleNodes.length; i++) {
        const el = roleNodes[i];
        if (el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host')) continue;
        const r = (el.getAttribute('data-message-author-role') || '').toLowerCase();
        const t = (el.textContent || '').trim();
        if (r === 'user') {
          userCount += 1;
          lastRole = 'user';
        } else if (r === 'assistant' && t.length >= 2) {
          assistantCount += 1;
          lastRole = 'assistant';
        }
      }
      return { userCount, assistantCount, lastRoleIsUser: lastRole === 'user' };
    }
    const proseAssistant = getLastAssistantText(true, true);
    const hasUser = Boolean(extractLastUserMessageFromDom());
    return {
      userCount: hasUser ? 1 : 0,
      assistantCount: proseAssistant.length >= 2 ? 1 : 0,
      lastRoleIsUser: hasUser && proseAssistant.length < 2
    };
  }

  function findArenaInlineRetryButton() {
    const root = document.querySelector('main') || document.body;
    if (!root) return null;
    const btns = root.querySelectorAll('button');
    for (let i = btns.length - 1; i >= 0; i--) {
      const b = btns[i];
      if (!isElementDisplayed(b) || b.disabled) continue;
      if (b.closest('#arena-ultra-root') || b.closest('#arena-ultra-toolbar-host')) continue;
      const txt = (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (
        txt === 'retry' ||
        txt === 'try again' ||
        txt === 'tentar novamente' ||
        txt === 'reenviar' ||
        txt === 'retry message'
      ) {
        return b;
      }
    }
    return null;
  }

  function detectVisibleTransientErrorBanner() {
    const candidates = document.querySelectorAll(
      '[data-sonner-toast], [role="alert"], [role="status"], main [class*="destructive" i], main [class*="error" i], [data-radix-toast-viewport] li'
    );
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (!el || !el.isConnected) continue;
      if (el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host')) continue;
      if (el.closest('.prose, pre, code')) continue;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 320) continue;
      if (/token usage limit|daily limit|credits will refresh|out of credits|out of tokens/i.test(txt)) continue;
      if (TRANSIENT_ARENA_ERROR_RX.test(txt)) {
        return txt.slice(0, 90);
      }
    }
    return '';
  }

  function detectTransientSessionFailureState(now) {
    // 1. Direct network telemetry from page-bridge.js (e.g., HTTP 500/502/504/timeout on trigger-session or create-chat)
    if (runtime.lastTransientErrorAt > 0 && now - runtime.lastTransientErrorAt >= 1200 && now - runtime.lastTransientErrorAt < 120000) {
      return {
        detected: true,
        reason: runtime.lastTransientErrorReason || 'Failed to start session'
      };
    }

    // 2. Visible Arena toast / callout ("Failed to start session", "Failed to create chat session", etc.)
    const bannerHit = detectVisibleTransientErrorBanner();
    if (bannerHit && (runtime.lastSendAt > 0 || getComposerDraftText().trim().length > 0 || extractLastUserMessageFromDom())) {
      return {
        detected: true,
        reason: bannerHit
      };
    }

    // 3. Silent stuck / rejected send (e.g. toast already faded after 4s, or draft was restored to composer on /agent,
    //    or /agent/<id> trigger-session timed out at 15s leaving the user message unanswered with no Stop button!)
    if (runtime.lastSendAt > 0) {
      const elapsed = now - runtime.lastSendAt;
      const draftNow = getComposerDraftText().trim();

      // 3A: Still on /agent or composer still holds the rejected prompt after 6.5s with zero stream activity
      if (
        elapsed >= 6500 &&
        !runtime.sawActivitySinceLastSend &&
        (/^\/agent\/?$/i.test(location.pathname || '') || draftNow.length >= 2)
      ) {
        return {
          detected: true,
          reason: 'Envio não iniciou a sessão (prompt retido)'
        };
      }

      // 3B: On /agent/<id> after 17.5s (past Arena's 15s trigger-session timeout) with zero generation & last message still user!
      if (elapsed >= 17500) {
        const domTurn = getTurnDomState();
        if (!runtime.sawActivitySinceLastSend || (domTurn.userCount > 0 && domTurn.lastRoleIsUser)) {
          return {
            detected: true,
            reason: 'Sessão não respondeu após envio (Failed to start session)'
          };
        }
      }
    }

    return null;
  }

  async function recoverFromTransientSessionFailure(failureInfo) {
    const now = Date.now();
    const nextAttempt = (runtime.transientRetryCount || 0) + 1;
    const minCooldown = nextAttempt <= 1 ? 2600 : nextAttempt === 2 ? 4200 : 6200;
    if (now - (runtime.lastTransientRetryAt || 0) < minCooldown) {
      return false;
    }

    runtime.lastTransientRetryAt = now;
    runtime.transientRetryCount = nextAttempt;
    runtime.lastTransientErrorAt = 0;

    const draftText = getComposerDraftText().trim();
    const promptToResend = (
      draftText ||
      runtime.lastAttemptedPrompt ||
      runtime.initialSessionPrompt ||
      extractLastUserMessageFromDom() ||
      ''
    ).trim();

    const domTurn = getTurnDomState();
    const isBrokenEmptyAgentSession =
      /^\/agent\/[A-Za-z0-9_-]{3,}/i.test(location.pathname || '') &&
      domTurn.assistantCount === 0 &&
      nextAttempt >= 4 &&
      Boolean(promptToResend);

    // If a specific /agent/<uuid> sandbox failed 3 retries in a row on Turn 1 without ever producing a single assistant reply,
    // archive the broken empty chat and open a clean /agent tab with the exact same prompt!
    if (isBrokenEmptyAgentSession) {
      showToast('🔄 Sessão travada no Arena após 3 tentativas — arquivando e abrindo nova sessão limpa...', 'info');
      const archInfo = await archiveRefusedChatNow();
      runtime.transientRetryCount = 0;
      await sendBgMessage({
        type: 'AU_RECOVER_DEAD_SESSION',
        payload: {
          archived: archInfo.archived,
          convId: archInfo.convId || '',
          collabRoomId: runtime.collabRoomId || '',
          collabAgentName: runtime.collabAgentName || '',
          githubActive: Boolean(runtime.githubActive),
          githubRepo: runtime.githubRepo || '',
          githubBaseBranch: runtime.githubBaseBranch || '',
          githubBranch: runtime.githubBranch || '',
          refuseThinkingModels: isRefuseThinkingActive(),
          initialPrompt: runtime.initialSessionPrompt || promptToResend,
          autoContinueEnabled: runtime.autoContinueEnabled,
          strategy: runtime.strategy,
          fixedPrompt: runtime.customFixedPrompt,
          queue: runtime.promptQueue
        }
      });
      return true;
    }

    if (nextAttempt > 10) {
      showToast('⚠️ Arena falhou ao iniciar a sessão 10 vezes seguidas. Pausando tentativas automáticas.', 'error');
      runtime.lastSendAt = 0;
      runtime.transientRetryCount = 0;
      return false;
    }

    // If Arena's client state explicitly demands a page refresh (e.g. "Stopped chat response cannot be matched. Reload the chat..."),
    // persist autopilot + pendingReloadPrompt to sessionStorage and reload once cleanly!
    if (failureInfo && NEEDS_PAGE_RELOAD_ERROR_RX.test(failureInfo.reason || '') && nextAttempt <= 2) {
      if (promptToResend) {
        runtime.pendingReloadPrompt = promptToResend;
      }
      saveToTabSessionStorage();
      showToast('🔄 Sincronizando estado do chat no Arena (recarregando sessão)...', 'info');
      setTimeout(() => {
        try {
          location.reload();
        } catch (_) {}
      }, 350);
      return true;
    }

    // Check if Arena rendered an explicit Retry button while locking the composer ("Recover the previous message...")
    const retryBtn = findArenaInlineRetryButton();
    const inputEl = findChatInput();
    if (retryBtn && (!inputEl || inputEl.disabled)) {
      showToast(`🔄 "${failureInfo.reason}" — clicando em Tentar Novamente (#${nextAttempt})...`, 'info');
      try {
        retryBtn.click();
      } catch (_) {}
      runtime.lastSendAt = Date.now();
      runtime.sawActivitySinceLastSend = false;
      return true;
    }

    if (!promptToResend) {
      if (retryBtn) {
        try {
          retryBtn.click();
        } catch (_) {}
        runtime.lastSendAt = Date.now();
        return true;
      }
      return false;
    }

    showToast(
      `🔄 Falha no Arena (${failureInfo.reason}) — reenviando o prompt automaticamente (#${nextAttempt})...`,
      'info'
    );
    const res = await injectAndSubmitPrompt(promptToResend, 'session_error_retry', { isRetry: true });
    if (res === true) {
      ensurePromptToolbarMounted();
    }
    return Boolean(res);
  }

  // --- Main Auto-Continue Tick Engine ---
  async function evaluateAutoContinueTick() {
    if (!isCurrentInstance()) return;

    const now = Date.now();
    // Deduplicate overlapping local interval + Service Worker heartbeat ticks (<380ms apart)
    if (!runtime.justEnabledReadyToFire && now - runtime.lastTickAt < 380) return;
    runtime.lastTickAt = now;

    // Watchdog: never let sendingInProgress stay wedged if OS Lock Screen / Sleep interrupted an earlier await!
    if (runtime.sendingInProgress && runtime.sendingStartedAt && now - runtime.sendingStartedAt > 18000) {
      runtime.sendingInProgress = false;
    }

    if (
      runtime.sendingInProgress ||
      captchaWatcherActive ||
      activeJobRunning ||
      Boolean(runtime.pendingLaunchJobId) ||
      runtime.refusingInProgress
    ) {
      return;
    }

    // Auto-expire stale netActiveStreams only if no chunk arrived for 90s (stream_end normally clears in 0ms;
    // 90s protects deep silent reasoning & long sandbox bash tool executions from premature expiry!)
    if (runtime.netActiveStreams > 0 && now - runtime.lastNetChunkAt >= 90000) {
      runtime.netActiveStreams = 0;
    }

    // Fast composer Stop button check FIRST so active streaming ticks stay sub-millisecond!
    const stopBtn = findStopButton();
    const hasFreshStream = runtime.netActiveStreams > 0 && now - runtime.lastNetChunkAt < 90000;
    const dueSlowGuard = !stopBtn || now - runtime.lastSlowGuardCheckAt >= 3200;
    if (dueSlowGuard) {
      runtime.lastSlowGuardCheckAt = now;
      applyCleanChatAutoPromptFilter();
    }

    if (!stopBtn) {
      sampleChatContentGrowth();
    } else {
      runtime.lastContentGrowthAt = now;
    }

    // 0. Always catch Security Verification (reCAPTCHA) even right after an initial launch!
    if (dueSlowGuard && detectSecurityVerificationOnPage() && (runtime.autoContinueEnabled || runtime.pendingLaunchJobId || now - runtime.lastSendAt < 15000)) {
      await enterCaptchaWaitingState(runtime.lastAttemptedPrompt || '', 'auto_resume');
      return;
    }

    // 0.5 Anti-Thinking Model Refusal Gate (Default ON): immediately stop & re-roll models showing
    // "> Thinking...", "🧠 Thinking...", or "🧠 Thought for X seconds"
    if (isRefuseThinkingActive() && (runtime.autoContinueEnabled || now - runtime.lastSendAt < 65000)) {
      const thinkingHit = detectThinkingModelIndicator();
      if (thinkingHit) {
        await stopAndRefuseThinkingModel(thinkingHit);
        return;
      }
    }

    const inInitialLaunchRecoveryWindow =
      runtime.initialLaunchSentAt > 0 && now - runtime.initialLaunchSentAt < 45000;
    const hasSoloGithubWatch =
      !runtime.collabRoomId &&
      (Boolean(runtime.githubActive) || Boolean(runtime.hasVaultToken)) &&
      settings.githubAutoCreatePR !== false &&
      runtime.sawActivitySinceLastSend;

    if (!runtime.autoContinueEnabled && !inInitialLaunchRecoveryWindow && !runtime.pendingReloadPrompt && !hasSoloGithubWatch) {
      return;
    }

    // 1. Immediate Hard Stop check on true token/credit limit
    if (settings.hardStopOnTokenLimit && dueSlowGuard) {
      const limitReason = detectTokenLimitOnPage();
      if (limitReason) {
        triggerImmediateTokenStop(limitReason);
        return;
      }
    }

    // 1.5 ARENA-04: Detect interactive human-in-the-loop tool cards (ask_user, add_voice, generate_image, Connectors)
    if (dueSlowGuard && AU_ARENA_ADAPTER && typeof AU_ARENA_ADAPTER.findPendingHumanInteraction === 'function') {
      const pendingUi = AU_ARENA_ADAPTER.findPendingHumanInteraction(document);
      if (pendingUi && pendingUi.pending) {
        runtime.sawActivitySinceLastSend = true;
        if (runtime.status !== 'waiting_user' || runtime.pendingHumanInteraction !== pendingUi.kind) {
          runtime.status = 'waiting_user';
          runtime.pendingHumanInteraction = pendingUi.kind || 'interactive_card';
          runtime.stopReason = pendingUi.label || '⏸ Aguardando sua seleção no card interativo';
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
        }
        return;
      } else if (runtime.status === 'waiting_user') {
        runtime.status = 'idle';
        runtime.pendingHumanInteraction = '';
        runtime.stopReason = '';
        syncTabStateToBackground();
        renderToolbarAndDrawerStatus();
      }
    }

    // 2. Is Arena genuinely generating right now?
    const isRecoveringStream = !stopBtn && detectAndHandleArenaStreamRecovery();
    const isGeneratingNow = Boolean(stopBtn) || hasFreshStream || isRecoveringStream;

    if (isGeneratingNow) {
      runtime.sawActivitySinceLastSend = true;
      runtime.transientRetryCount = 0;
      runtime.collabWaitingPeers = false;
      if (runtime.status !== 'generating') {
        runtime.status = 'generating';
        syncTabStateToBackground();
        renderToolbarAndDrawerStatus();
      }

      if (now - runtime.lastMidTurnCheckAt >= 3200 && !runtime.refusingInProgress) {
        runtime.lastMidTurnCheckAt = now;
        const elapsedSinceSend = runtime.lastSendAt ? now - runtime.lastSendAt : 99999;
        if (elapsedSinceSend >= 4500) {
          const liveTxt = getLastAssistantText(true, true);
          if (liveTxt.length >= 35 && !detectThinkingModelIndicator()) {
            if (/\/(?:agent|c)\/[A-Za-z0-9_-]{3,}/i.test(location.pathname || '')) {
              runtime.cleanConvPathConfirmed = location.pathname;
              stopFastThinkingWatchWindow();
            }
            if (runtime.collabRoomId && !runtime.admittedToTeam) {
              runtime.admittedToTeam = true;
              renderToolbarAndDrawerStatus();
              sendBgMessage({
                type: 'AU_COLLAB_CONFIRM_CLEAN_ADMISSION',
                payload: {
                  roomId: runtime.collabRoomId,
                  bindingEpoch: runtime.collabBindingEpoch
                }
              });
            }
          }

          if (runtime.collabRoomId && runtime.admittedToTeam && liveTxt.includes('[/TEMPCHAT]')) {
            const liveMatches = Array.from(liveTxt.matchAll(/\[TEMPCHAT\]([\s\S]*?)\[\/TEMPCHAT\]/gi));
            const latestMatch = liveMatches.length > 0 ? liveMatches[liveMatches.length - 1] : null;
            if (latestMatch && latestMatch[1] && latestMatch[1].trim().length >= 4) {
              const msgBody = latestMatch[1].trim();
              const hasRealWords = /[A-Za-zÀ-ÿ0-9]{4,}/.test(msgBody) && !isAutoOrSystemPromptText(msgBody);
              const h = `${msgBody.length}:${msgBody.slice(0, 80)}:${msgBody.slice(-40)}`;
              if (hasRealWords && h !== runtime.lastLiveStreamedChatHash) {
                runtime.lastLiveStreamedChatHash = h;
                sendBgMessage({
                  type: 'AU_COLLAB_LIVE_PROSE_MSG',
                  payload: {
                    roomId: runtime.collabRoomId,
                    bindingEpoch: runtime.collabBindingEpoch,
                    text: msgBody
                  }
                });
              }
            }
          }
        }
      }
      return;
    }

    if (runtime.status === 'generating') {
      runtime.status = 'idle';
      syncTabStateToBackground();
      renderToolbarAndDrawerStatus();
    }

    // 2.5 Auto-Retry on transient Arena session/send failures
    if (dueSlowGuard) {
      const transientFailure = detectTransientSessionFailureState(now);
      if (transientFailure && transientFailure.detected) {
        await recoverFromTransientSessionFailure(transientFailure);
        return;
      }
    }

    if (!runtime.autoContinueEnabled && !runtime.pendingReloadPrompt) {
      const lastSoloActivity = Math.max(runtime.lastContentGrowthAt, runtime.lastNetChunkAt);
      if (hasSoloGithubWatch && now - lastSoloActivity >= 2500) {
        triggerSoloGithubTurnSafetyNetIfNeeded();
      }
      return;
    }

    // 3. Wait minimum cooldown since last send so Arena has time to start the request
    if (!runtime.justEnabledReadyToFire && now - runtime.lastSendAt < 4000) {
      return;
    }

    const reviewPanel = findTaskReviewPanel();
    if (reviewPanel) {
      runtime.sawActivitySinceLastSend = true;
    }

    const readyOnSavedSession =
      runtime.lastSendAt === 0 &&
      (hasConversationHistoryInDom() ||
        runtime.promptQueue.length > 0 ||
        Boolean((runtime.customFixedPrompt || '').trim())) &&
      getComposerDraftText().length === 0;

    if (!runtime.sawActivitySinceLastSend && !runtime.justEnabledReadyToFire && !readyOnSavedSession) {
      return;
    }

    const settleMs = Math.max(1500, Number(settings.settleDelayMs || 3200));
    const lastRealActivity = Math.max(runtime.lastContentGrowthAt, runtime.lastNetChunkAt);
    if (!runtime.justEnabledReadyToFire && !reviewPanel && now - lastRealActivity < settleMs) {
      return;
    }

    const inputEl = findChatInput();
    if ((!inputEl || inputEl.disabled) && !reviewPanel) {
      return;
    }

    if (settings.autoSaveSnapshots && runtime.sawActivitySinceLastSend && now - runtime.lastAutoSaveAt >= 90000) {
      runtime.lastAutoSaveAt = now;
      autoSaveCurrentConversationSnapshot();
    }

    if (isRefuseThinkingActive()) {
      const postTurnThinkingHit = detectThinkingModelIndicator();
      if (postTurnThinkingHit) {
        await stopAndRefuseThinkingModel(postTurnThinkingHit);
        return;
      }
      if (/\/(?:agent|c)\/[A-Za-z0-9_-]{3,}/i.test(location.pathname || '')) {
        runtime.cleanConvPathConfirmed = location.pathname;
      }
    }

    // 7. Pick next prompt & dispatch!
    let chosen = null;

    if (runtime.pendingReloadPrompt) {
      chosen = {
        text: runtime.pendingReloadPrompt,
        source: 'reload_recovery'
      };
      runtime.pendingReloadPrompt = '';
      saveToTabSessionStorage();
    } else if (runtime.collabRoomId) {
      runtime.sendingInProgress = true;
      runtime.sendingStartedAt = Date.now();
      const lastAssistantText = getLastAssistantText(false, true);
      const collabDecision = await sendBgMessage({
        type: 'AU_COLLAB_TURN_COMPLETED',
        payload: {
          roomId: runtime.collabRoomId,
          bindingEpoch: runtime.collabBindingEpoch,
          filteredReasoningBlocks: runtime.filteredReasoningBlocks || 0,
          assistantText: lastAssistantText,
          thinkingIndicator: isRefuseThinkingActive() ? (detectThinkingModelIndicator() || '') : ''
        }
      });
      runtime.sendingInProgress = false;

      // ARENA-18: If SW rejected stale room bindingEpoch or unbound this tab, immediately clear local room state!
      if (collabDecision && collabDecision.action === 'unbound_stale_epoch') {
        runtime.collabRoomId = '';
        runtime.collabBindingEpoch = 0;
        runtime.collabWaitingPeers = false;
        saveToTabSessionStorage();
        syncTabStateToBackground();
        renderToolbarAndDrawerStatus();
        return;
      }

      if (!runtime.autoContinueEnabled) return;

      if (collabDecision && collabDecision.ok) {
        if (collabDecision.action === 'refused_thinking') {
          return;
        }
        if (collabDecision.action === 'needs_human') {
          runtime.autoContinueEnabled = false;
          runtime.collabWaitingPeers = false;
          runtime.status = 'needs_human';
          runtime.stopReason = collabDecision.reason || 'Ação humana necessária na sala';
          updateWebLock();
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
          showToast(`⏸ ${runtime.stopReason}`, 'info');
          return;
        }
        if (!runtime.admittedToTeam) {
          runtime.admittedToTeam = true;
          renderToolbarAndDrawerStatus();
        }
        if (collabDecision.action === 'stop_completed') {
          runtime.autoContinueEnabled = false;
          runtime.collabWaitingPeers = false;
          runtime.status = 'idle';
          runtime.stopReason = collabDecision.reason || `Entrega Final Consolidada na Sala #${runtime.collabRoomId}`;
          updateWebLock();
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
          showToast(`🤝 ${runtime.stopReason}`, 'success');
          return;
        }
        const hasPendingUniteKickoff =
          runtime.promptQueue.length > 0 &&
          /CONECTADO EM TEMPO REAL À SALA TEMPCHAT/i.test(String(runtime.promptQueue[0] || ''));

        if (collabDecision.action === 'wait_peers' && !hasPendingUniteKickoff) {
          if (!runtime.collabWaitingPeers) {
            runtime.collabWaitingPeers = true;
            syncTabStateToBackground();
            renderToolbarAndDrawerStatus();
          }
          return;
        }
        if (collabDecision.action === 'wait_peers' && hasPendingUniteKickoff) {
          runtime.collabWaitingPeers = false;
          const koItem = runtime.promptQueue.shift();
          saveToTabSessionStorage();
          chosen = {
            text: koItem,
            source: 'collab_unite_kickoff',
            fromQueue: true,
            queueItem: koItem
          };
        } else if (collabDecision.action === 'send_collab_prompt' && collabDecision.prompt) {
          runtime.collabWaitingPeers = false;
          let koPrefixItem = '';
          if (hasPendingUniteKickoff) {
            koPrefixItem = runtime.promptQueue.shift();
            saveToTabSessionStorage();
          }
          const prefixKickoff = koPrefixItem ? koPrefixItem + '\n\n' : '';
          chosen = {
            text: prefixKickoff + collabDecision.prompt,
            source: `tempchat:#${runtime.collabRoomId}`,
            fromQueue: Boolean(koPrefixItem),
            queueItem: koPrefixItem
          };
        }
      }
    }

    if (!chosen) {
      runtime.collabWaitingPeers = false;
      triggerSoloGithubTurnSafetyNetIfNeeded();
      if (!runtime.autoContinueEnabled) return;
      chosen = selectNextContinuePrompt();
      if (settings.agentKitEnabled === true && runtime.initialSessionPrompt && runtime.initialSessionPrompt.includes('AGENT KIT')) {
        chosen.text = String(chosen.text || '').slice(0,1700) + '\nKit: /tmp/au_agent tick; consulte só o guia necessário e inclua doctor + report na resposta final. Não reinstale o kit.';
      } else if (settings.harnessEnabled !== false && !runtime.collabRoomId && globalThis.AU_HARNESS) {
        if (!runtime.harnessInitialized) {
          chosen.text += '\n' + AU_HARNESS.bootstrap({ roomId: 'manual', mode: runtime.strategy || settings.autoContinueStrategy });
          chosen.harnessBootstrap = true;
        } else chosen.text = String(chosen.text || '').slice(0,1700) + '\n' + AU_HARNESS.continuation(runtime.strategy || settings.autoContinueStrategy);
      }
    }
    if (!chosen || !chosen.text) return;

    const delayMs = runtime.justEnabledReadyToFire || chosen.source === 'reload_recovery'
      ? 180
      : Math.max(250, Number(settings.sendDelayMs || 1000));
    runtime.sendingInProgress = true;
    runtime.sendingStartedAt = Date.now();
    runtime.status = 'waiting_send';
    renderToolbarAndDrawerStatus();

    await bgSafeSleep(delayMs);
    runtime.sendingInProgress = false;
    if (!runtime.autoContinueEnabled && chosen.source !== 'reload_recovery') return;
    if (findStopButton() || (runtime.netActiveStreams > 0 && Date.now() - runtime.lastNetChunkAt < 90000)) return;
    if (settings.hardStopOnTokenLimit) {
      const recheck = detectTokenLimitOnPage();
      if (recheck) {
        triggerImmediateTokenStop(recheck);
        return;
      }
    }
    const sendResult = await injectAndSubmitPrompt(chosen.text, chosen.source, {
      expectedConvKey: runtime.boundConvKey || ''
    });
    if (sendResult === true) {
      if (chosen.harnessBootstrap) runtime.harnessInitialized = true;
      saveToTabSessionStorage();
      syncTabStateToBackground();
      ensurePromptToolbarMounted();
    } else if (sendResult === false && runtime.status !== 'token_stopped' && runtime.status !== 'needs_human') {
      if (chosen.source === 'reload_recovery') {
        runtime.pendingReloadPrompt = chosen.text;
        saveToTabSessionStorage();
      } else if (chosen.fromQueue && chosen.queueItem && !runtime.promptQueue.includes(chosen.queueItem)) {
        runtime.promptQueue.unshift(chosen.queueItem);
        saveToTabSessionStorage();
      }
    }
  }

  function triggerSoloGithubTurnSafetyNetIfNeeded() {
    if (
      runtime.collabRoomId ||
      (!runtime.hasVaultToken && !runtime.githubActive) ||
      settings.githubAutoCreatePR === false
    ) {
      return;
    }
    const lastReplyForGh = getLastAssistantText(true);
    const hasExplicitPushTag = Boolean(lastReplyForGh && /\[GITHUB_PUSH_PRONTO\]/i.test(lastReplyForGh));
    if (!lastReplyForGh || lastReplyForGh.length <= 20 || (!runtime.githubActive && !hasExplicitPushTag)) {
      return;
    }
    const syncSig = `${lastReplyForGh.length}:${lastReplyForGh.slice(0, 80)}:${lastReplyForGh.slice(-120)}`;
    if (runtime.lastSoloGithubSyncHash === syncSig) return;
    runtime.lastSoloGithubSyncHash = syncSig;
    sendBgMessage({
      type: 'AU_SOLO_GITHUB_TURN_COMPLETED',
      assistantText: lastReplyForGh,
      githubActive: Boolean(runtime.githubActive),
      githubRepo: runtime.githubRepo || settings.githubDefaultRepo || '',
      githubBaseBranch: runtime.githubBaseBranch || settings.githubBaseBranch || 'main',
      githubBranch: runtime.githubBranch || ''
    }).then((ghOut) => {
      const prUrl = (ghOut && ghOut.pullRequest && ghOut.pullRequest.htmlUrl) || (ghOut && ghOut.htmlUrl);
      if (ghOut && ghOut.ok && prUrl && !ghOut.alreadyExisted) {
        showToast(`🚀 PR criado automaticamente no GitHub sem você no loop!`, 'success');
      }
    });
  }

  // --- Auto-Save Conversation Snapshot ---
  async function autoSaveCurrentConversationSnapshot(customFolderId, customTags) {
    try {
      const msgs = scrapeConversationMessages();
      if (!msgs.length) return null;
      const totalChars = msgs.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);
      runtime.estimatedSessionTokens = Math.ceil(totalChars / 3.8);

      const cleanTitle =
        (document.title || '')
          .replace(/^⚠️ \[SEM TOKENS\]\s*/, '')
          .trim() ||
        (msgs[0]?.content || 'Sessão Arena.ai').slice(0, 60);

      const convId = getCurrentOrCreatedConvId();
      const canonicalUrl =
        convId && /^\/agent\/?$/i.test(location.pathname || '')
          ? `${location.origin}/agent/${convId}`
          : location.href;

      const saved = await AU_STORAGE.upsertSavedChat({
        ...(convId ? { id: `conv_${convId}` } : {}),
        sessionUrl: canonicalUrl,
        title: cleanTitle,
        mode: detectCurrentArenaMode(),
        loopsCount: runtime.loopsCount,
        messages: msgs,
        ...(customFolderId !== undefined ? { folderId: customFolderId } : {}),
        ...(customTags !== undefined ? { tags: customTags } : {})
      });
      return saved;
    } catch (_) {
      return null;
    }
  }

  // --- Battle Mode Vote Observer ---
  function setupBattleVoteObserver() {
    document.addEventListener(
      'click',
      (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const btn = target.closest('main button');
        if (!btn || btn.closest('#arena-ultra-root') || btn.closest('#arena-ultra-toolbar-host')) return;
        const txt = (btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
        if (!txt || txt.length > 48) return;

        let winner = null;
        if (txt.includes('a is better') || txt.includes('left is better') || txt.includes('modelo a')) winner = 'modelA';
        else if (txt.includes('b is better') || txt.includes('right is better') || txt.includes('modelo b')) winner = 'modelB';
        else if (txt === 'tie' || txt.includes('it\'s a tie') || txt === 'empate') winner = 'tie';
        else if (txt.includes('both are bad') || txt.includes('ambos ruins')) winner = 'both_bad';

        if (winner) {
          setTimeout(() => {
            const headings = Array.from(document.querySelectorAll('main h2, main h3, main [class*="model" i]'))
              .map((n) => (n.textContent || '').trim())
              .filter((s) => s.length > 2 && s.length < 55);
            const firstMsgEl = document.querySelector('main [data-message-author-role="user"], main .prose, main article');
            const firstSnippet = ((firstMsgEl && firstMsgEl.textContent) || '').trim().slice(0, 120);
            AU_STORAGE.recordBattleVote({
              winner,
              modelA: headings[0] || 'Modelo A',
              modelB: headings[1] || 'Modelo B',
              promptSnippet: firstSnippet
            }).catch(() => {});
            showToast('Voto do Battle registrado nas Estatísticas!', 'success');
          }, 900);
        }
      },
      true
    );
  }

  // --- File Download Helper for Exports ---
  function triggerFileDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 500);
  }

  // =========================================================================
  // UI LAYER — SHADOW DOM DRAWER, FAB, SLASH POPUP & PROMPT TOOLBAR
  // =========================================================================
  let rootHost = null;
  let shadow = null;
  let toolbarHost = null;
  let toolbarShadow = null;

  const SHADOW_CSS = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      color: #f4f4f5;
    }
    * { box-sizing: border-box; }

    /* Discreet Official-Style Floating Action Button */
    .au-fab {
      position: fixed;
      right: 18px;
      bottom: 22px;
      z-index: 2147483640;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border-radius: 999px;
      background: #14161b;
      color: #f8fafc;
      border: 1px solid #2a2f3a;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 600;
      transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
      user-select: none;
    }
    .au-fab:hover {
      background: #1c1f26;
      border-color: #3f4656;
      transform: translateY(-1px);
    }
    .au-fab.hidden { display: none; }
    .au-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #71717a;
      flex-shrink: 0;
    }
    .au-dot.active {
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }
    .au-dot.error {
      background: #ef4444;
      box-shadow: 0 0 8px #ef4444;
    }
    .au-dot.captcha {
      background: #f59e0b;
      box-shadow: 0 0 8px #f59e0b;
    }

    /* Retractable Native-Style Drawer */
    .au-drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: 400px;
      max-width: 94vw;
      height: 100vh;
      background: #111318;
      color: #f4f4f5;
      border-left: 1px solid #262932;
      box-shadow: -12px 0 36px rgba(0, 0, 0, 0.45);
      z-index: 2147483645;
      display: flex;
      flex-direction: column;
      transform: translateX(102%);
      transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .au-drawer.open {
      transform: translateX(0);
    }

    .au-drawer-header {
      padding: 14px 16px;
      border-bottom: 1px solid #23262f;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #14161c;
    }
    .au-brand {
      display: flex;
      align-items: center;
      gap: 9px;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: -0.01em;
    }
    .au-brand-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.14);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.28);
    }
    .au-icon-btn {
      background: transparent;
      border: 1px solid #272a34;
      color: #a1a1aa;
      border-radius: 7px;
      padding: 5px 9px;
      font-size: 12px;
      cursor: pointer;
    }
    .au-icon-btn:hover {
      background: #1e212a;
      color: #fafafa;
    }

    .au-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 8px 12px;
      border-bottom: 1px solid #23262f;
      background: #13151b;
    }
    .au-tab {
      flex: 1 1 calc(25% - 4px);
      background: transparent;
      border: 1px solid transparent;
      color: #a1a1aa;
      font-size: 11.5px;
      font-weight: 600;
      padding: 7px 6px;
      border-radius: 7px;
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      transition: all 0.14s ease;
    }
    .au-tab:hover { color: #f4f4f5; background: #1a1d25; }
    .au-tab.active {
      background: #1f232d;
      color: #ffffff;
      border-color: #323746;
    }

    .au-body {
      flex: 1;
      overflow-y: auto;
      padding: 14px 16px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .au-card {
      background: #171920;
      border: 1px solid #252934;
      border-radius: 10px;
      padding: 12px 13px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .au-card-title {
      font-size: 12.5px;
      font-weight: 700;
      color: #f4f4f5;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .au-muted {
      font-size: 11.5px;
      color: #9ca3af;
      line-height: 1.45;
    }

    .au-input, .au-select, .au-textarea {
      width: 100%;
      background: #101217;
      color: #f4f4f5;
      border: 1px solid #2b303d;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12.5px;
      font-family: inherit;
      outline: none;
    }
    .au-input:focus, .au-select:focus, .au-textarea:focus {
      border-color: #10b981;
    }
    .au-textarea {
      min-height: 68px;
      resize: vertical;
      line-height: 1.45;
    }

    .au-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid #2e3340;
      background: #1e222b;
      color: #f4f4f5;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.14s ease, border-color 0.14s ease;
    }
    .au-btn:hover { background: #272c38; border-color: #3f4656; }
    .au-btn-primary {
      background: #10b981;
      border-color: #059669;
      color: #052e1f;
      font-weight: 700;
    }
    .au-btn-primary:hover { background: #34d399; }
    .au-btn-danger {
      background: rgba(239, 68, 68, 0.14);
      border-color: rgba(239, 68, 68, 0.35);
      color: #fca5a5;
    }
    .au-btn-danger:hover { background: rgba(239, 68, 68, 0.24); }
    .au-row { display: flex; gap: 8px; align-items: center; }
    .au-row-wrap { display: flex; gap: 6px; flex-wrap: wrap; }

    .au-queue-item {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      background: #111319;
      border: 1px solid #242834;
      border-radius: 8px;
      font-size: 12px;
    }
    .au-badge {
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #232733;
      color: #d4d4d8;
      font-weight: 600;
    }
    .au-theme-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    .au-theme-card {
      padding: 9px 10px;
      border-radius: 8px;
      background: #111319;
      border: 1px solid #262a36;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .au-theme-card.active {
      border-color: #10b981;
      background: rgba(16, 185, 129, 0.08);
    }
    .au-swatches { display: flex; gap: 4px; }
    .au-swatch { width: 13px; height: 13px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.22); }

    /* Slash Commands Floating Menu */
    .au-slash-menu {
      position: fixed;
      z-index: 2147483646;
      width: 360px;
      max-width: 92vw;
      max-height: 290px;
      overflow-y: auto;
      background: #14161d;
      border: 1px solid #2e3342;
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.48);
      padding: 6px;
      display: none;
    }
    .au-slash-menu.open { display: block; }
    .au-slash-item {
      padding: 8px 10px;
      border-radius: 7px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .au-slash-item:hover { background: #202430; }
    .au-slash-top { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: #f4f4f5; }
    .au-slash-cmd { color: #34d399; font-family: ui-monospace, monospace; }
    .au-slash-desc { font-size: 11px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Variable Fill Modal */
    .au-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.62);
      z-index: 2147483647;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .au-modal-backdrop.open { display: flex; }
    .au-modal {
      width: 420px;
      max-width: 100%;
      background: #151821;
      border: 1px solid #2d3240;
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
    }

    /* Toast */
    .au-toast {
      position: fixed;
      bottom: 70px;
      right: 18px;
      z-index: 2147483647;
      background: #181b24;
      color: #f8fafc;
      border: 1px solid #2e3444;
      border-radius: 9px;
      padding: 9px 14px;
      font-size: 12.5px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition: all 0.2s ease;
    }
    .au-toast.show { opacity: 1; transform: translateY(0); }
    .au-toast.error { border-color: #ef4444; color: #fecaca; }
    .au-toast.success { border-color: #10b981; color: #a7f3d0; }
  `;

  const TOOLBAR_CSS = `
    :host {
      all: initial;
      display: block;
      width: 100%;
      margin-bottom: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 10px;
      background: rgba(20, 22, 28, 0.92);
      border: 1px solid rgba(63, 70, 86, 0.55);
      color: #e4e4e7;
      font-size: 11.5px;
      backdrop-filter: blur(8px);
    }
    .bar.hidden { display: none; }
    .left, .right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border-radius: 999px;
      border: 1px solid #2e3340;
      background: #1a1d24;
      color: #e4e4e7;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.14s ease;
      user-select: none;
    }
    .pill:hover { background: #242833; border-color: #434a5c; }
    .pill.active {
      background: rgba(16, 185, 129, 0.16);
      border-color: rgba(16, 185, 129, 0.5);
      color: #6ee7b7;
    }
    .pill.stopped {
      background: rgba(239, 68, 68, 0.18);
      border-color: rgba(239, 68, 68, 0.55);
      color: #fca5a5;
    }
    .pill.captcha {
      background: rgba(245, 158, 11, 0.18);
      border-color: rgba(245, 158, 11, 0.55);
      color: #fcd34d;
    }
    .pill.collab {
      background: rgba(6, 182, 212, 0.16);
      border-color: rgba(6, 182, 212, 0.52);
      color: #67e8f9;
    }
    .pill.nothink-on {
      background: rgba(244, 63, 94, 0.15);
      border-color: rgba(244, 63, 94, 0.5);
      color: #fda4af;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #71717a; }
    .pill.active .dot { background: #10b981; box-shadow: 0 0 6px #10b981; }
    .pill.stopped .dot { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
    .pill.captcha .dot { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
    select.mini-select {
      background: #1a1d24;
      color: #d4d4d8;
      border: 1px solid #2e3340;
      border-radius: 999px;
      padding: 3.5px 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      outline: none;
    }
    .tok-badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #9ca3af;
      padding: 2px 6px;
    }
  `;

  function showToast(message, variant = 'info') {
    if (!shadow) return;
    const t = shadow.getElementById('au-toast');
    if (!t) return;
    t.textContent = message;
    t.className = `au-toast show ${variant}`;
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => {
      t.className = 'au-toast';
    }, 3200);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function mountRootShadowUI() {
    if (!isCurrentInstance()) return;
    // Remove any stale root host left over from a previous extension reload on this tab!
    document.querySelectorAll('#arena-ultra-root').forEach((el) => {
      if (el !== rootHost) el.remove();
    });
    if (rootHost && rootHost.isConnected) return;

    rootHost = document.createElement('div');
    rootHost.id = 'arena-ultra-root';
    document.documentElement.appendChild(rootHost);
    shadow = rootHost.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>${SHADOW_CSS}</style>

      <button id="au-fab" class="au-fab" title="Abrir Painel Arena Ultra">
        <span id="au-fab-dot" class="au-dot"></span>
        <span id="au-fab-label">Arena Ultra</span>
      </button>

      <aside id="au-drawer" class="au-drawer" aria-label="Painel Arena Ultra">
        <div class="au-drawer-header">
          <div class="au-brand">
            <span>Arena Ultra</span>
            <span id="au-header-badge" class="au-brand-badge">INATIVO</span>
          </div>
          <div class="au-row">
            <button id="au-open-dash-btn" class="au-icon-btn" title="Abrir Central em Tela Cheia">Central ↗</button>
            <button id="au-close-drawer-btn" class="au-icon-btn" title="Fechar Painel">✕</button>
          </div>
        </div>

        <nav class="au-tabs">
          <button class="au-tab active" data-tab="autopilot">Autopilot</button>
          <button class="au-tab" data-tab="multi">Multi-Agent</button>
          <button class="au-tab" data-tab="collab">🤝 TempChat</button>
          <button class="au-tab" data-tab="github">🐙 GitHub</button>
          <button class="au-tab" data-tab="prompts">Prompts</button>
          <button class="au-tab" data-tab="export">Salvar</button>
          <button class="au-tab" data-tab="visual">Visual</button>
        </nav>

        <div id="au-drawer-body" class="au-body"></div>
      </aside>

      <div id="au-slash-menu" class="au-slash-menu"></div>

      <div id="au-var-modal-backdrop" class="au-modal-backdrop">
        <div class="au-modal">
          <div class="au-card-title">
            <span id="au-var-modal-title">Preencher Variáveis do Template</span>
            <button id="au-var-modal-close" class="au-icon-btn">✕</button>
          </div>
          <div id="au-var-modal-fields" style="display:flex;flex-direction:column;gap:8px;"></div>
          <div class="au-row" style="justify-content:flex-end;">
            <button id="au-var-insert-btn" class="au-btn">Inserir no Campo</button>
            <button id="au-var-send-btn" class="au-btn au-btn-primary">Enviar Agora</button>
          </div>
        </div>
      </div>

      <div id="au-toast" class="au-toast"></div>
    `;

    shadow.getElementById('au-fab').addEventListener('click', () => {
      runtime.drawerOpen = !runtime.drawerOpen;
      renderDrawer();
    });
    shadow.getElementById('au-close-drawer-btn').addEventListener('click', () => {
      runtime.drawerOpen = false;
      renderDrawer();
    });
    shadow.getElementById('au-open-dash-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'AU_OPEN_DASHBOARD' });
    });
    shadow.querySelectorAll('.au-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        runtime.activeDrawerTab = btn.dataset.tab;
        shadow.querySelectorAll('.au-tab').forEach((b) => b.classList.toggle('active', b === btn));
        renderDrawerBody();
      });
    });
    shadow.getElementById('au-var-modal-close').addEventListener('click', () => {
      shadow.getElementById('au-var-modal-backdrop').classList.remove('open');
    });

    renderDrawer();
  }

  function bindLiveComposerListeners(inputEl) {
    if (!inputEl || inputEl._auBound) return;
    inputEl._auBound = true;
    const syncInputState = () => {
      const rawVal = inputEl.value !== undefined ? inputEl.value : (inputEl.innerText || inputEl.textContent || '');
      const val = rawVal.replace(/\u200B/g, '').replace(/^\n+$/, '');
      const nextTok = AU_STORAGE.estimateTokens(val);
      if (nextTok !== runtime.currentInputTokens) {
        runtime.currentInputTokens = nextTok;
        renderToolbarAndDrawerStatus();
      }

      const trimmed = val.trim();
      if (settings.slashCommandsEnabled && trimmed.startsWith('/') && !trimmed.includes('\n') && trimmed.length <= 28) {
        openSlashMenuNearInput(trimmed.slice(1).trim().toLowerCase());
      } else if (runtime.slashPopupOpen) {
        closeSlashMenu();
      }
    };
    const captureManualFirstSubmission = () => {
      const rawVal = inputEl.value !== undefined ? inputEl.value : (inputEl.innerText || inputEl.textContent || '');
      const clean = rawVal.replace(/\u200B/g, '').trim();
      if (clean && !runtime.initialSessionPrompt && !isSavedConversationUrl()) {
        runtime.initialSessionPrompt = clean;
        try {
          chrome.runtime.sendMessage({ type: 'AU_REMEMBER_INITIAL_PROMPT', prompt: clean });
        } catch (_) {}
      }
      if (clean) {
        runtime.lastSendAt = Date.now();
        if (isRefuseThinkingActive()) {
          startFastThinkingWatchWindow(48000);
        }
      }
    };
    inputEl.addEventListener('input', syncInputState);
    inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && runtime.slashPopupOpen) {
        closeSlashMenu();
        return;
      }
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !runtime.slashPopupOpen) {
        captureManualFirstSubmission();
      }
    });
    const compAnchor = findComposerAnchor(inputEl);
    if (compAnchor && !compAnchor._auSendBound) {
      compAnchor._auSendBound = true;
      compAnchor.addEventListener(
        'click',
        (ev) => {
          const btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
          if (!btn || btn.closest('#arena-ultra-root') || btn.closest('#arena-ultra-toolbar-host')) return;
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (aria === 'send message' || aria === 'enviar mensagem' || Boolean(btn.querySelector('svg path[d*="M3 12L21 12"]'))) {
            captureManualFirstSubmission();
          }
        },
        true
      );
    }
  }

  let lastMountedPathname = '';

  function ensurePromptToolbarMounted(forceFullCheck = false) {
    if (!isCurrentInstance()) return;

    if (!settings.promptToolbarVisible) {
      if (toolbarHost) toolbarHost.style.display = 'none';
      return;
    }

    // O(1) Fast-path when toolbar is already mounted above a live visible composer/review card:
    // Still ensures late-hydrated .tiptap gets bound for `/` slash commands AND refreshes workspace button on SPA URL transitions!
    if (
      !forceFullCheck &&
      toolbarHost &&
      toolbarHost.isConnected &&
      toolbarShadow &&
      toolbarShadow.getElementById('tb-dl-workspace') &&
      toolbarShadow.getElementById('tb-gh-push') &&
      toolbarShadow.getElementById('tb-refuse-thinking') &&
      toolbarHost.style.display !== 'none' &&
      toolbarHost.nextElementSibling &&
      toolbarHost.nextElementSibling.isConnected &&
      isElementDisplayed(toolbarHost.nextElementSibling)
    ) {
      const sibling = toolbarHost.nextElementSibling;
      const innerEditor =
        sibling.querySelector &&
        sibling.querySelector('.tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], textarea:not([readonly])');
      if (innerEditor && !innerEditor._auBound) {
        bindLiveComposerListeners(innerEditor);
      }
      if (location.pathname !== lastMountedPathname) {
        lastMountedPathname = location.pathname;
        renderToolbarAndDrawerStatus();
      }
      return;
    }

    // Purge any stale or duplicate toolbar host (e.g. from reloading the extension on an open tab!)
    document.querySelectorAll('#arena-ultra-toolbar-host').forEach((el) => {
      if (el !== toolbarHost) el.remove();
    });

    const inputEl = findChatInput();
    const anchorTarget = findComposerAnchor(inputEl);
    if (!anchorTarget || !anchorTarget.parentElement) return;

    if (!toolbarHost) {
      toolbarHost = document.createElement('div');
      toolbarHost.id = 'arena-ultra-toolbar-host';
      toolbarShadow = toolbarHost.attachShadow({ mode: 'open' });
      toolbarShadow.innerHTML = `
        <style>${TOOLBAR_CSS}</style>
        <div id="au-bar" class="bar">
          <div class="left">
            <button id="tb-toggle-loop" class="pill" title="Ligar/Desligar Auto-Continue até esgotar tokens">
              <span class="dot"></span>
              <span id="tb-loop-text">Autopilot: OFF</span>
            </button>
            <button id="tb-refuse-thinking" class="pill nothink-on" title="Modo Padrão: Parar e recusar modelos que mostrem '> Thinking...' ou 'Thought for X seconds' e só adicionar ao Time modelos sem Thinking">
              <span id="tb-refuse-thinking-text">🚫 Sem Thinking: ON</span>
            </button>
            <select id="tb-strategy" class="mini-select" title="Modo do Auto-Continue">
              <option value="hybrid">Modo: Completo (Regras+Fila+Fixo)</option>
              <option value="fixed">Modo: Prompt Fixo</option>
              <option value="queue">Modo: Fila + Loop</option>
              <option value="conditional">Modo: Regras Inteligentes</option>
            </select>
            <button id="tb-slash-btn" class="pill" title="Abrir Biblioteca de Prompts e Comandos /">/ Prompts</button>
            <button id="tb-queue-btn" class="pill" title="Gerenciar Fila de Etapas">Fila (<span id="tb-queue-count">0</span>)</button>
            <button id="tb-multi-btn" class="pill" title="Começar vários chats no modo Agent ao mesmo tempo">+ Multi-Agent</button>
            <button id="tb-livechat-btn" class="pill collab" title="Abrir Guia Dedicada 'Chat Live' para ver os Agents conversando em tempo real e conversar com eles">⚡ Chat Live</button>
            <button id="tb-hide-autoprompts" class="pill" title="Ocultar/Mostrar prompts automáticos e do sistema no chat ao vivo para ver apenas os Agents">🙈 Prompts Auto</button>
            <button id="tb-collab-btn" class="pill collab" style="display:none;" title="Abrir Sala TempChat Colaborativa desta aba">🤝 #<span id="tb-collab-code"></span></button>
          </div>
          <div class="right">
            <button id="tb-gh-push" class="pill" style="display:none;" title="Enviar arquivos do Workspace desta sessão direto para seu GitHub">🐙 GitHub</button>
            <button id="tb-dl-workspace" class="pill" style="display:none;" title="Baixar arquivos do Workspace desta sessão Agent">⬇ Workspace</button>
            <span id="tb-tokens" class="tok-badge" title="Estimativa de tokens (campo atual / sessão)">~0 tok</span>
            <button id="tb-open-drawer" class="pill" title="Abrir Painel Lateral Arena Ultra">Painel ☰</button>
          </div>
        </div>
      `;

      toolbarShadow.getElementById('tb-toggle-loop').addEventListener('click', () => {
        toggleAutoContinue(!runtime.autoContinueEnabled);
      });
      toolbarShadow.getElementById('tb-refuse-thinking').addEventListener('click', async () => {
        const nextVal = !isRefuseThinkingActive();
        runtime.jobRefuseThinking = nextVal;
        settings = await AU_STORAGE.saveSettings({ refuseThinkingModels: nextVal });
        if (runtime.collabRoomId) {
          sendBgMessage({
            type: 'AU_COLLAB_SET_ROOM_STATE',
            roomId: runtime.collabRoomId,
            refuseThinkingModels: nextVal
          });
        }
        if (nextVal) {
          const hit = detectThinkingModelIndicator();
          if (hit) {
            stopAndRefuseThinkingModel(hit);
          } else {
            showToast('🚫 Modo Sem-Thinking ATIVADO: modelos Thinking serão parados e recusados!', 'success');
          }
        } else {
          if (runtime.collabRoomId) runtime.admittedToTeam = true;
          stopFastThinkingWatchWindow();
          showToast('Modo Sem-Thinking desativado (modelos Thinking permitidos).', 'info');
        }
        renderToolbarAndDrawerStatus();
      });
      toolbarShadow.getElementById('tb-strategy').addEventListener('change', (e) => {
        runtime.strategy = e.target.value;
        AU_STORAGE.saveSettings({ autoContinueStrategy: runtime.strategy });
        syncTabStateToBackground();
        renderToolbarAndDrawerStatus();
      });
      toolbarShadow.getElementById('tb-slash-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openSlashMenuNearInput('');
      });
      toolbarShadow.getElementById('tb-queue-btn').addEventListener('click', () => {
        runtime.drawerOpen = true;
        runtime.activeDrawerTab = 'autopilot';
        renderDrawer();
      });
      toolbarShadow.getElementById('tb-multi-btn').addEventListener('click', () => {
        runtime.drawerOpen = true;
        runtime.activeDrawerTab = 'multi';
        renderDrawer();
      });
      toolbarShadow.getElementById('tb-livechat-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'AU_OPEN_LIVECHAT',
          roomId: runtime.collabRoomId || ''
        });
      });
      toolbarShadow.getElementById('tb-hide-autoprompts').addEventListener('click', async () => {
        const nextHide = settings.hideAutoPromptsInChat === false;
        settings = await AU_STORAGE.saveSettings({ hideAutoPromptsInChat: nextHide });
        syncCleanChatVisibilityAttr();
        applyCleanChatAutoPromptFilter();
        chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
        showToast(
          nextHide
            ? '🙈 Prompts automáticos/sistema OCULTADOS no chat ao vivo!'
            : '👁️ Prompts automáticos/sistema visíveis novamente no chat.',
          nextHide ? 'success' : 'info'
        );
        renderToolbarAndDrawerStatus();
      });
      toolbarShadow.getElementById('tb-collab-btn').addEventListener('click', () => {
        runtime.drawerOpen = true;
        runtime.activeDrawerTab = 'collab';
        if (runtime.collabRoomId) runtime.selectedDrawerRoomId = runtime.collabRoomId;
        renderDrawer();
      });
      toolbarShadow.getElementById('tb-gh-push').addEventListener('click', () => {
        runtime.drawerOpen = true;
        runtime.activeDrawerTab = 'github';
        renderDrawer();
      });
      toolbarShadow.getElementById('tb-dl-workspace').addEventListener('click', () => {
        downloadCurrentTabWorkspaceAsZip();
      });
      toolbarShadow.getElementById('tb-open-drawer').addEventListener('click', () => {
        runtime.drawerOpen = !runtime.drawerOpen;
        renderDrawer();
      });
    }

    toolbarHost.style.display = 'block';
    if (toolbarHost.nextElementSibling !== anchorTarget) {
      anchorTarget.parentElement.insertBefore(toolbarHost, anchorTarget);
      lastStatusRenderSig = '';
    }
    lastMountedPathname = location.pathname;

    bindLiveComposerListeners(inputEl);
    renderToolbarAndDrawerStatus();
  }

  function toggleAutoContinue(enable) {
    stopBlinkingTabTitle();
    runtime.autoContinueEnabled = Boolean(enable);
    if (runtime.autoContinueEnabled) {
      runtime.stopReason = '';
      const currentlyBusy =
        Boolean(findStopButton()) ||
        (runtime.netActiveStreams > 0 && Date.now() - runtime.lastNetChunkAt < 90000);
      runtime.status = currentlyBusy ? 'generating' : 'idle';
      runtime.sawActivitySinceLastSend = currentlyBusy;
      const hasDraft = getComposerDraftText().length > 0;
      runtime.justEnabledReadyToFire =
        !currentlyBusy &&
        !hasDraft &&
        (hasConversationHistoryInDom() ||
          Boolean(findTaskReviewPanel()) ||
          runtime.promptQueue.length > 0 ||
          Boolean((runtime.customFixedPrompt || '').trim()) ||
          runtime.strategy === 'fixed');
      showToast('Autopilot ativado! O Agent continuará até esgotar os tokens.', 'success');
    } else {
      runtime.status = 'paused';
      runtime.justEnabledReadyToFire = false;
      showToast('Autopilot pausado nesta aba.', 'info');
    }
    updateWebLock();
    syncTabStateToBackground();
    renderToolbarAndDrawerStatus();
    if (runtime.autoContinueEnabled) {
      bgSafeSleep(150).then(() => evaluateAutoContinueTick());
    }
  }

  let lastStatusRenderSig = '';

  function renderToolbarAndDrawerStatus() {
    const tbReady = toolbarHost && toolbarHost.isConnected && toolbarShadow ? 1 : 0;
    const refuseActive = isRefuseThinkingActive();
    const hideAutoActive = settings.hideAutoPromptsInChat !== false ? 1 : 0;
    const nextSig = `${tbReady}|${runtime.autoContinueEnabled ? 1 : 0}|${refuseActive ? 1 : 0}|${hideAutoActive}|${runtime.githubActive ? 1 : 0}|${runtime.admittedToTeam ? 1 : 0}|${runtime.status}|${runtime.stopReason}|${runtime.loopsCount}|${runtime.strategy}|${runtime.promptQueue.length}|${runtime.currentInputTokens}|${runtime.estimatedSessionTokens}|${settings.fabVisible ? 1 : 0}|${location.pathname}|${runtime.collabRoomId}|${runtime.collabWaitingPeers ? 1 : 0}|${runtime.drawerOpen ? runtime.activeDrawerTab : 'closed'}`;
    if (nextSig === lastStatusRenderSig && !runtime.drawerOpen) {
      return;
    }
    lastStatusRenderSig = nextSig;

    const isThinkingStopped =
      runtime.status === 'token_stopped' && /Thinking|Thought|Pensando|Pensou|recusado/i.test(runtime.stopReason || '');

    // Update FAB
    if (shadow) {
      const fab = shadow.getElementById('au-fab');
      const dot = shadow.getElementById('au-fab-dot');
      const lbl = shadow.getElementById('au-fab-label');
      const hBadge = shadow.getElementById('au-header-badge');

      if (fab) fab.classList.toggle('hidden', !settings.fabVisible);
      if (dot) {
        dot.className =
          'au-dot' +
          (runtime.status === 'token_stopped'
            ? ' error'
            : runtime.status === 'captcha_waiting'
              ? ' captcha'
              : runtime.autoContinueEnabled
                ? ' active'
                : '');
      }
      if (lbl) {
        if (isThinkingStopped) lbl.textContent = '🚫 Thinking Recusado';
        else if (runtime.status === 'token_stopped') lbl.textContent = 'Sem Tokens!';
        else if (runtime.status === 'captcha_waiting') lbl.textContent = '🛡️ Marque Não sou Robô';
        else if (runtime.autoContinueEnabled && runtime.collabRoomId) {
          lbl.textContent = runtime.collabWaitingPeers
            ? `🤝 #${runtime.collabRoomId} • Sincronizando`
            : !runtime.admittedToTeam && refuseActive
              ? `🔍 #${runtime.collabRoomId} • Triagem`
              : `🤝 #${runtime.collabRoomId} • #${runtime.loopsCount}`;
        } else if (runtime.autoContinueEnabled) lbl.textContent = `Autopilot • #${runtime.loopsCount}`;
        else lbl.textContent = runtime.collabRoomId ? `🤝 Sala #${runtime.collabRoomId}` : 'Arena Ultra';
      }
      if (hBadge) {
        if (isThinkingStopped) {
          hBadge.textContent = 'THINKING RECUSADO';
          hBadge.style.color = '#fda4af';
        } else if (runtime.status === 'token_stopped') {
          hBadge.textContent = 'SEM TOKENS';
          hBadge.style.color = '#fca5a5';
        } else if (runtime.status === 'captcha_waiting') {
          hBadge.textContent = 'AGUARDANDO RECAPTCHA';
          hBadge.style.color = '#fcd34d';
        } else if (runtime.autoContinueEnabled) {
          hBadge.textContent = runtime.collabRoomId
            ? `TEMPCHAT #${runtime.collabRoomId} • ${runtime.loopsCount}`
            : `ATIVO • ${runtime.loopsCount} LOOPS`;
          hBadge.style.color = runtime.collabRoomId ? '#67e8f9' : '#34d399';
        } else {
          hBadge.textContent = runtime.collabRoomId ? `SALA #${runtime.collabRoomId}` : 'PAUSADO';
          hBadge.style.color = '#a1a1aa';
        }
      }
    }

    // Update Prompt Toolbar
    if (toolbarShadow) {
      const pill = toolbarShadow.getElementById('tb-toggle-loop');
      const text = toolbarShadow.getElementById('tb-loop-text');
      const refuseBtn = toolbarShadow.getElementById('tb-refuse-thinking');
      const refuseTxt = toolbarShadow.getElementById('tb-refuse-thinking-text');
      const hideAutoBtn = toolbarShadow.getElementById('tb-hide-autoprompts');

      if (hideAutoBtn) {
        const hiddenNow = settings.hideAutoPromptsInChat !== false;
        hideAutoBtn.textContent = hiddenNow ? '🙈 Prompts Auto' : '👁️ Prompts Auto';
        hideAutoBtn.style.borderColor = hiddenNow ? 'rgba(16,185,129,0.45)' : '';
        hideAutoBtn.style.color = hiddenNow ? '#6ee7b7' : '';
      }
      const stratSel = toolbarShadow.getElementById('tb-strategy');
      const qCount = toolbarShadow.getElementById('tb-queue-count');
      const tokSpan = toolbarShadow.getElementById('tb-tokens');
      const dlBtn = toolbarShadow.getElementById('tb-dl-workspace');
      const ghBtn = toolbarShadow.getElementById('tb-gh-push');
      const collabBtn = toolbarShadow.getElementById('tb-collab-btn');
      const collabCode = toolbarShadow.getElementById('tb-collab-code');

      if (refuseBtn && refuseTxt) {
        refuseBtn.className = 'pill' + (refuseActive ? ' nothink-on' : '');
        refuseTxt.textContent = refuseActive ? '🚫 Sem Thinking: ON' : 'Sem Thinking: OFF';
      }

      if (collabBtn && collabCode) {
        if (runtime.collabRoomId) {
          collabBtn.style.display = 'inline-flex';
          const shortRole = runtime.collabAgentName
            ? runtime.collabAgentName.replace(/^Agente \d+ \(|\)$/g, '')
            : '';
          const gateTag = !runtime.admittedToTeam && refuseActive ? ' • Triagem' : '';
          collabCode.textContent = shortRole
            ? `${runtime.collabRoomId} • ${shortRole}${gateTag}`
            : `${runtime.collabRoomId}${gateTag}`;
        } else {
          collabBtn.style.display = 'none';
        }
      }

      if (pill && text) {
        pill.className =
          'pill' +
          (runtime.status === 'token_stopped'
            ? ' stopped'
            : runtime.status === 'captcha_waiting'
              ? ' captcha'
              : runtime.autoContinueEnabled
                ? ' active'
                : '');
        if (isThinkingStopped) {
          text.textContent = '🚫 Thinking Recusado (Parado)';
        } else if (runtime.status === 'token_stopped') {
          text.textContent = '⚠️ Sem Tokens (Parado)';
        } else if (runtime.status === 'captcha_waiting') {
          text.textContent = '🛡️ Marque "Não sou um robô" (Retoma sozinho!)';
        } else if (runtime.autoContinueEnabled) {
          const stLabel =
            runtime.status === 'generating'
              ? 'Trabalhando'
              : runtime.collabWaitingPeers
                ? 'Sincronizando Equipe'
                : 'Ativo';
          text.textContent = `Autopilot: ${stLabel} (${runtime.loopsCount})`;
        } else {
          text.textContent = 'Autopilot: OFF';
        }
      }
      if (stratSel && stratSel.value !== runtime.strategy) {
        stratSel.value = runtime.strategy;
      }
      if (qCount) qCount.textContent = String(runtime.promptQueue.length);
      if (tokSpan) {
        const total = runtime.currentInputTokens + runtime.estimatedSessionTokens;
        tokSpan.textContent = `~${total.toLocaleString('pt-BR')} tok`;
      }
      const isSavedAgentSession =
        /\/agent\/[a-zA-Z0-9_-]+/i.test(location.pathname) ||
        (/\/c\/[a-zA-Z0-9_-]+/i.test(location.pathname) && detectCurrentArenaMode() === 'agent');
      if (dlBtn) {
        dlBtn.style.display = isSavedAgentSession ? 'inline-flex' : 'none';
      }
      if (ghBtn) {
        ghBtn.style.display = 'inline-flex';
      }
    }
  }

  // --- Slash Menu & Template Variable Modal ---
  function openSlashMenuNearInput(queryStr) {
    if (!shadow) return;
    const menu = shadow.getElementById('au-slash-menu');
    const input = findChatInput();
    if (!menu || !input) return;

    const q = (queryStr || '').toLowerCase();
    const matches = promptsList.filter((p) => {
      if (!q) return true;
      return (
        (p.slash || '').toLowerCase().includes(q) ||
        (p.title || '').toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
      );
    });

    if (!matches.length) {
      closeSlashMenu();
      return;
    }

    const rect = input.getBoundingClientRect();
    menu.style.left = Math.max(12, Math.min(window.innerWidth - 376, rect.left)) + 'px';
    menu.style.bottom = Math.max(12, window.innerHeight - rect.top + 8) + 'px';

    menu.innerHTML = matches
      .map(
        (p) => `
        <div class="au-slash-item" data-id="${escapeHtml(p.id)}">
          <div class="au-slash-top">
            <span>${escapeHtml(p.title)}</span>
            <span class="au-slash-cmd">${escapeHtml(p.slash || '')}</span>
          </div>
          <div class="au-slash-desc">${escapeHtml(p.content)}</div>
        </div>
      `
      )
      .join('');

    menu.querySelectorAll('.au-slash-item').forEach((el) => {
      el.addEventListener('click', () => {
        const chosen = promptsList.find((x) => x.id === el.dataset.id);
        closeSlashMenu();
        if (chosen) applyPromptTemplate(chosen, false);
      });
    });

    menu.classList.add('open');
    runtime.slashPopupOpen = true;
  }

  function closeSlashMenu() {
    if (!shadow) return;
    const menu = shadow.getElementById('au-slash-menu');
    if (menu) menu.classList.remove('open');
    runtime.slashPopupOpen = false;
  }

  document.addEventListener('click', (e) => {
    if (runtime.slashPopupOpen && e.target !== rootHost && e.target !== toolbarHost) {
      closeSlashMenu();
    }
  });

  function applyPromptTemplate(promptObj, sendImmediately) {
    const vars = AU_STORAGE.extractVariables(promptObj.content);
    if (vars.length === 0) {
      const inp = findChatInput();
      if (sendImmediately) {
        injectAndSubmitPrompt(promptObj.content, 'template');
      } else if (inp) {
        setInputValueCleanly(inp, promptObj.content);
        showToast(`Template "${promptObj.title}" inserido!`, 'success');
      }
      return;
    }

    // Open variable fill modal inside Shadow DOM
    const backdrop = shadow.getElementById('au-var-modal-backdrop');
    const fieldsBox = shadow.getElementById('au-var-modal-fields');
    shadow.getElementById('au-var-modal-title').textContent = promptObj.title;

    fieldsBox.innerHTML = vars
      .map(
        (v) => `
        <div>
          <label class="au-muted" style="display:block;margin-bottom:4px;font-weight:600;">{{${escapeHtml(v)}}}</label>
          <input class="au-input au-var-field" data-var="${escapeHtml(v)}" placeholder="Digite o valor para ${escapeHtml(v)}..." />
        </div>
      `
      )
      .join('');

    const collectFilled = () => {
      const map = {};
      fieldsBox.querySelectorAll('.au-var-field').forEach((inp) => {
        map[inp.dataset.var] = inp.value.trim();
      });
      return AU_STORAGE.fillVariables(promptObj.content, map);
    };

    const insertBtn = shadow.getElementById('au-var-insert-btn');
    const sendBtn = shadow.getElementById('au-var-send-btn');

    insertBtn.onclick = () => {
      const finalTxt = collectFilled();
      backdrop.classList.remove('open');
      const chatInp = findChatInput();
      if (chatInp) setInputValueCleanly(chatInp, finalTxt);
      showToast('Prompt preenchido no campo de mensagem!', 'success');
    };
    sendBtn.onclick = () => {
      const finalTxt = collectFilled();
      backdrop.classList.remove('open');
      injectAndSubmitPrompt(finalTxt, 'template');
    };

    backdrop.classList.add('open');
  }

  let drawerCollabPollTimer = null;
  function clearDrawerCollabPoll() {
    if (drawerCollabPollTimer) {
      clearInterval(drawerCollabPollTimer);
      drawerCollabPollTimer = null;
    }
  }

  // --- Drawer Renderer (6 Full Modules inside Arena.ai!) ---
  function renderDrawer() {
    if (!shadow) return;
    const dr = shadow.getElementById('au-drawer');
    if (dr) dr.classList.toggle('open', runtime.drawerOpen);
    shadow.querySelectorAll('.au-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === runtime.activeDrawerTab);
    });
    if (runtime.drawerOpen) {
      renderDrawerBody();
    } else {
      clearDrawerCollabPoll();
    }
    renderToolbarAndDrawerStatus();
  }

  function renderDrawerBody() {
    if (!shadow) return;
    const body = shadow.getElementById('au-drawer-body');
    if (!body) return;

    const tab = runtime.activeDrawerTab;
    if (tab !== 'collab') {
      clearDrawerCollabPoll();
    }

    if (tab === 'autopilot') {
      const currentFixed = runtime.customFixedPrompt || settings.fixedContinuePrompt;
      body.innerHTML = `
        <div class="au-card">
          <div class="au-card-title">
            <span>Loop Autônomo (Agent Mode)</span>
            <span class="au-badge">${runtime.loopsCount} turnos enviados</span>
          </div>
          <div class="au-muted">
            Assim que o Agent parar de responder, envia o próximo prompt automaticamente e só para imediatamente quando acabarem os tokens.
          </div>
          ${
            runtime.status === 'token_stopped'
              ? `<div style="padding:8px 10px;border-radius:8px;background:rgba(239,68,68,0.14);border:1px solid rgba(239,68,68,0.4);color:#fecaca;font-size:12px;">
                  <strong>Parada imediata acionada:</strong> ${escapeHtml(runtime.stopReason)}
                 </div>`
              : ''
          }
          <div class="au-row">
            <button id="dr-toggle-autopilot" class="au-btn ${runtime.autoContinueEnabled ? 'au-btn-danger' : 'au-btn-primary'}" style="flex:1;">
              ${runtime.autoContinueEnabled ? '⏸ Pausar Autopilot nesta Aba' : '▶ Iniciar Autopilot até Esgotar Tokens'}
            </button>
            <button id="dr-fire-now" class="au-btn" title="Disparar próximo prompt agora">Enviar 1x</button>
          </div>
        </div>

        <div class="au-card" style="border-color:rgba(244,63,94,0.42);">
          <div class="au-card-title">
            <span style="color:#fda4af;">🚫 Recusar Modelos Thinking (Padrão)</span>
            <span class="au-badge">${isRefuseThinkingActive() ? 'ATIVO' : 'OFF'}</span>
          </div>
          <label class="au-row au-muted" style="cursor:pointer;">
            <input id="dr-refuse-thinking" type="checkbox" ${isRefuseThinkingActive() ? 'checked' : ''} />
            <span>Parar e recusar modelos que mostrem <code>&gt; Thinking...</code>, <code>🧠 Thinking...</code> ou <code>Thought for X seconds</code></span>
          </label>
          <label class="au-row au-muted" style="cursor:pointer;">
            <input id="dr-refuse-reroll" type="checkbox" ${settings.refuseThinkingAutoReroll !== false ? 'checked' : ''} />
            <span>Sortear novo chat <code>/agent</code> automaticamente até achar modelo sem Thinking (e só então adicionar ao Time)</span>
          </label>
          <div class="au-row">
            <span class="au-muted" style="flex:1;">Máx. re-sorteios seguidos por vaga:</span>
            <input id="dr-refuse-max" type="number" min="1" max="40" value="${Number(settings.refuseThinkingMaxRetries || 15)}" class="au-input" style="width:74px;" />
          </div>
        </div>

        <div class="au-card">
          <div class="au-card-title"><span>Modo & Prompt de Continuação</span></div>
          <select id="dr-strategy" class="au-select">
            <option value="hybrid" ${runtime.strategy === 'hybrid' ? 'selected' : ''}>Todos Combinados (Regras -> Fila -> Fixo)</option>
            <option value="fixed" ${runtime.strategy === 'fixed' ? 'selected' : ''}>Apenas Prompt Fixo Contínuo</option>
            <option value="queue" ${runtime.strategy === 'queue' ? 'selected' : ''}>Fila de Etapas + Loop Contínuo</option>
            <option value="conditional" ${runtime.strategy === 'conditional' ? 'selected' : ''}>Regras Condicionais Inteligentes</option>
          </select>
          <textarea id="dr-fixed-prompt" class="au-textarea" placeholder="Prompt enviado quando o Agent parar...">${escapeHtml(currentFixed)}</textarea>
          <button id="dr-save-fixed" class="au-btn">Salvar Prompt Padrão</button>
        </div>

        <div class="au-card">
          <div class="au-card-title">
            <span>Fila Sequencial desta Aba</span>
            <span class="au-badge">${runtime.promptQueue.length} na fila</span>
          </div>
          <div class="au-row">
            <select id="dr-macro-select" class="au-select" style="flex:1;">
              <option value="">Carregar Macro de Workflow...</option>
              ${macrosList.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${m.steps.length} etapas)</option>`).join('')}
            </select>
            <button id="dr-load-macro" class="au-btn">Carregar</button>
          </div>
          <div class="au-row">
            <input id="dr-new-queue-step" class="au-input" placeholder="Adicionar etapa na fila..." />
            <button id="dr-add-step" class="au-btn">+ Etapa</button>
          </div>
          <div id="dr-queue-list" style="display:flex;flex-direction:column;gap:6px;">
            ${
              runtime.promptQueue.length === 0
                ? '<div class="au-muted">Fila vazia — usará regras inteligentes e o prompt fixo contínuo.</div>'
                : runtime.promptQueue
                    .map(
                      (step, idx) => `
                  <div class="au-queue-item">
                    <span><strong>#${idx + 1}:</strong> ${escapeHtml(step.slice(0, 110))}${step.length > 110 ? '...' : ''}</span>
                    <button class="au-icon-btn dr-del-step" data-idx="${idx}">✕</button>
                  </div>
                `
                    )
                    .join('')
            }
          </div>
        </div>
      `;

      body.querySelector('#dr-toggle-autopilot').onclick = () => {
        toggleAutoContinue(!runtime.autoContinueEnabled);
        renderDrawerBody();
      };
      body.querySelector('#dr-refuse-thinking').onchange = async (e) => {
        const nextVal = e.target.checked;
        runtime.jobRefuseThinking = null;
        settings = await AU_STORAGE.saveSettings({ refuseThinkingModels: nextVal });
        renderToolbarAndDrawerStatus();
        renderDrawerBody();
        if (nextVal) {
          const hit = detectThinkingModelIndicator();
          if (hit) stopAndRefuseThinkingModel(hit);
        }
      };
      body.querySelector('#dr-refuse-reroll').onchange = async (e) => {
        settings = await AU_STORAGE.saveSettings({ refuseThinkingAutoReroll: e.target.checked });
      };
      body.querySelector('#dr-refuse-max').onchange = async (e) => {
        const v = Math.max(1, Math.min(40, Number(e.target.value || 15)));
        settings = await AU_STORAGE.saveSettings({ refuseThinkingMaxRetries: v });
      };
      body.querySelector('#dr-fire-now').onclick = () => {
        const next = selectNextContinuePrompt();
        if (next && next.text) injectAndSubmitPrompt(next.text, 'manual_step');
      };
      body.querySelector('#dr-strategy').onchange = (e) => {
        runtime.strategy = e.target.value;
        AU_STORAGE.saveSettings({ autoContinueStrategy: runtime.strategy });
        syncTabStateToBackground();
        renderToolbarAndDrawerStatus();
      };
      body.querySelector('#dr-save-fixed').onclick = async () => {
        const val = body.querySelector('#dr-fixed-prompt').value.trim();
        runtime.customFixedPrompt = val;
        settings = await AU_STORAGE.saveSettings({ fixedContinuePrompt: val });
        showToast('Prompt contínuo salvo!', 'success');
      };
      body.querySelector('#dr-add-step').onclick = () => {
        const inp = body.querySelector('#dr-new-queue-step');
        const v = inp.value.trim();
        if (!v) return;
        runtime.promptQueue.push(v);
        inp.value = '';
        syncTabStateToBackground();
        renderDrawerBody();
        renderToolbarAndDrawerStatus();
      };
      body.querySelector('#dr-load-macro').onclick = () => {
        const id = body.querySelector('#dr-macro-select').value;
        const m = macrosList.find((x) => x.id === id);
        if (!m) return;
        runtime.promptQueue = runtime.promptQueue.concat(m.steps);
        if (m.loopPromptAfterQueue) runtime.customFixedPrompt = m.loopPromptAfterQueue;
        syncTabStateToBackground();
        renderDrawerBody();
        renderToolbarAndDrawerStatus();
        showToast(`Macro "${m.name}" carregada na fila!`, 'success');
      };
      body.querySelectorAll('.dr-del-step').forEach((btn) => {
        btn.onclick = () => {
          runtime.promptQueue.splice(Number(btn.dataset.idx), 1);
          syncTabStateToBackground();
          renderDrawerBody();
          renderToolbarAndDrawerStatus();
        };
      });
      return;
    }

    if (tab === 'multi') {
      body.innerHTML = `
        <div class="au-card">
          <div class="au-card-title"><span>Começar Vários Chats no Agent Mode</span></div>
          <div class="au-muted">Abre múltiplas abas em <code>arena.ai/agent</code> em paralelo e já ativa o Auto-Continue em todas.</div>
          <select id="ml-mode" class="au-select">
            <option value="swarm">Enxame (Mesmo prompt em N abas Agent)</option>
            <option value="task_list">Lista de Tarefas (1 linha = 1 aba Agent)</option>
            <option value="matrix">Matriz de Variáveis (Template + itens)</option>
          </select>

          <div id="ml-swarm-box" style="display:flex;flex-direction:column;gap:8px;">
            <div class="au-row">
              <span class="au-muted" style="flex:1;">Quantidade de chats simultâneos:</span>
              <input id="ml-count" type="number" min="2" max="15" value="3" class="au-input" style="width:78px;" />
            </div>
            <textarea id="ml-swarm-prompt" class="au-textarea" placeholder="Digite o prompt inicial que será executado nos múltiplos Agents..."></textarea>
          </div>

          <div id="ml-tasks-box" style="display:none;flex-direction:column;gap:8px;">
            <textarea id="ml-tasks-list" class="au-textarea" style="min-height:110px;" placeholder="Tarefa da Aba 1&#10;Tarefa da Aba 2&#10;Tarefa da Aba 3"></textarea>
          </div>

          <div id="ml-matrix-box" style="display:none;flex-direction:column;gap:8px;">
            <textarea id="ml-matrix-tpl" class="au-textarea" placeholder="Ex: Crie um micro-app completo para {{item}} com testes e preview."></textarea>
            <input id="ml-matrix-var" class="au-input" value="item" placeholder="Nome da variável (ex: item)" />
            <textarea id="ml-matrix-vals" class="au-textarea" placeholder="Um valor por linha (ex: Gestão Financeira&#10;Pomodoro Pro&#10;CRM Kanban)"></textarea>
          </div>

          <label class="au-row au-muted" style="cursor:pointer;">
            <input id="ml-autoloop" type="checkbox" checked />
            <span>Já ligar Auto-Continue automaticamente em todas as abas</span>
          </label>
          <label class="au-row au-muted" style="cursor:pointer;">
            <input id="ml-autogroup" type="checkbox" checked />
            <span>Agrupar abas automaticamente no navegador</span>
          </label>
          <label class="au-row" style="cursor:pointer;font-size:11.5px;padding:7px 9px;border-radius:8px;border:1px solid rgba(244,63,94,0.42);background:rgba(244,63,94,0.1);color:#fda4af;">
            <input id="ml-refuse-thinking" type="checkbox" ${settings.refuseThinkingModels !== false ? 'checked' : ''} />
            <span><strong>🚫 Recusar Modelos Thinking (Padrão):</strong> para <code>Thinking...</code> / <code>Thought for...</code> e só adiciona ao Time modelos sem Thinking</span>
          </label>

          <div style="border:1px solid rgba(6,182,212,0.38);background:rgba(6,182,212,0.08);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;">
            <label class="au-row" style="cursor:pointer;font-weight:700;color:#67e8f9;font-size:12.5px;">
              <input id="ml-collab-enabled" type="checkbox" />
              <span>🤝 Ativar Modo Colaboração (Sala TempChat 4 dígitos)</span>
            </label>
            <div id="ml-collab-opts" style="display:none;flex-direction:column;gap:7px;">
              <div class="au-muted" style="font-size:11px;">
                Coloca todos os Agents numa sala TempChat compartilhada para dividirem descobertas, revisarem código e consolidarem um resultado superior e mais rápido.
              </div>
              <select id="ml-collab-profile" class="au-select">
                <option value="specialists" ${settings.collabDefaultProfile === 'specialists' ? 'selected' : ''}>Equipe de Especialistas (Arquiteto + Implementador + QA + Sintetizador)</option>
                <option value="parallel_leader" ${settings.collabDefaultProfile === 'parallel_leader' ? 'selected' : ''}>Divisão Paralela + Líder Sintetizador</option>
                <option value="debate_consensus" ${settings.collabDefaultProfile === 'debate_consensus' ? 'selected' : ''}>Debate & Consenso entre Pares</option>
              </select>
              <select id="ml-collab-stop" class="au-select">
                <option value="smart_consensus" ${settings.collabDefaultStopMode === 'smart_consensus' ? 'selected' : ''}>Conclusão: Parada Inteligente na Entrega Final</option>
                <option value="endless_tokens" ${settings.collabDefaultStopMode === 'endless_tokens' ? 'selected' : ''}>Conclusão: Refinamento Contínuo até Esgotar Tokens</option>
              </select>
              <label class="au-row au-muted" style="cursor:pointer;font-size:11.5px;">
                <input id="ml-collab-external" type="checkbox" ${settings.collabMirrorExternalTempChat ? 'checked' : ''} />
                <span>🌐 Espelhar também numa aba real do <code>tempchat.online</code></span>
              </label>
            </div>
          </div>

          <div style="border:1px solid rgba(139,92,246,0.38);background:rgba(139,92,246,0.08);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;">
            <label class="au-row" style="cursor:pointer;font-weight:700;color:#c4b5fd;font-size:12.5px;">
              <input id="ml-gh-enabled" type="checkbox" ${settings.githubEnabledInCollab && settings.githubDefaultRepo ? 'checked' : ''} />
              <span>🐙 Conectar Link do meu GitHub (Público ou Privado)</span>
            </label>
            <div id="ml-gh-opts" style="display:${settings.githubEnabledInCollab && settings.githubDefaultRepo ? 'flex' : 'none'};flex-direction:column;gap:7px;">
              <div class="au-row">
                <input id="ml-gh-repo" class="au-input" value="${escapeHtml(settings.githubDefaultRepo || '')}" placeholder="Cole o link: https://github.com/usuario/repo (ou usuario/repo)" style="flex:1;" />
                <input id="ml-gh-base" class="au-input" value="${escapeHtml(settings.githubBaseBranch || 'main')}" placeholder="main" style="width:82px;" title="Branch base (main / master)" />
              </div>
              <input id="ml-gh-token" type="password" autocomplete="off" class="au-input" value="" placeholder="${runtime.hasVaultToken ? '🔒 Token já ativo no Cofre de Sessão (deixe vazio p/ usar o atual ou cole novo)' : '🔑 Token PAT p/ salvar no Cofre de Sessão (opcional p/ público)'}" />
              <select id="ml-gh-auth" class="au-select">
                <option value="vault_broker_zero_token" ${!settings.githubAuthMode || settings.githubAuthMode === 'vault_broker_zero_token' ? 'selected' : ''}>Auth: 🔐 Cofre Zero-Token no Prompt (Broker + CAS • Sem expor PAT!)</option>
                <option value="extension_proxy_push" ${settings.githubAuthMode === 'extension_proxy_push' ? 'selected' : ''}>Auth: Push Seguro via Extensão (Snapshot ZIP + Sem expor PAT)</option>
              </select>
              <select id="ml-gh-branch" class="au-select">
                <option value="branch_per_agent_pr" ${settings.githubBranchMode === 'branch_per_agent_pr' ? 'selected' : ''}>Branches: Branch por Agente + Merge/PR pelo Líder</option>
                <option value="single_shared_branch" ${settings.githubBranchMode === 'single_shared_branch' ? 'selected' : ''}>Branches: Branch Única Compartilhada (pull --rebase)</option>
              </select>
              <div class="au-muted" style="font-size:10.8px;">💡 Repositório público ("normal") clona mesmo sem Token! Para repositório privado ou <code>git push</code>, cole o Token PAT acima.</div>
            </div>
            <label class="au-row au-muted" style="cursor:pointer;font-size:11.5px;border-top:1px solid rgba(255,255,255,0.08);padding-top:7px;">
              <input id="ml-tf-enabled" type="checkbox" ${settings.tempFilesEnabledInCollab !== false ? 'checked' : ''} />
              <span>📦 Hub de Arquivos Temp (Filebin + Litterbox + Uguu + x0.at)</span>
            </label>
          </div>

          <button id="ml-launch-btn" class="au-btn au-btn-primary">🚀 Lançar Chats Agent Agora</button>
          <button id="ml-join-open-btn" class="au-btn" style="border-color:rgba(6,182,212,0.45);color:#67e8f9;">🤝 Unir Abas Abertas numa Sala TempChat</button>
        </div>

        <div class="au-card">
          <div class="au-card-title">
            <span>Orquestração Multi-Abas</span>
            <button id="ml-refresh-tabs" class="au-icon-btn">Atualizar</button>
          </div>
          <div class="au-row-wrap">
            <button id="ml-pause-all" class="au-btn">⏸ Pausar Todas</button>
            <button id="ml-resume-all" class="au-btn">▶ Retomar Todas</button>
            <button id="ml-split-win" class="au-btn">⧉ Dividir Lado a Lado</button>
          </div>
          <div id="ml-live-tabs" style="display:flex;flex-direction:column;gap:6px;">
            <div class="au-muted">Carregando abas abertas...</div>
          </div>
        </div>
      `;

      const modeSel = body.querySelector('#ml-mode');
      modeSel.onchange = () => {
        body.querySelector('#ml-swarm-box').style.display = modeSel.value === 'swarm' ? 'flex' : 'none';
        body.querySelector('#ml-tasks-box').style.display = modeSel.value === 'task_list' ? 'flex' : 'none';
        body.querySelector('#ml-matrix-box').style.display = modeSel.value === 'matrix' ? 'flex' : 'none';
      };

      const collabChk = body.querySelector('#ml-collab-enabled');
      collabChk.onchange = () => {
        body.querySelector('#ml-collab-opts').style.display = collabChk.checked ? 'flex' : 'none';
        if (collabChk.checked) {
          body.querySelector('#ml-autoloop').checked = true;
        }
      };

      const ghChk = body.querySelector('#ml-gh-enabled');
      ghChk.onchange = () => {
        body.querySelector('#ml-gh-opts').style.display = ghChk.checked ? 'flex' : 'none';
      };

      const mlRepoInp = body.querySelector('#ml-gh-repo');
      const mlBaseInp = body.querySelector('#ml-gh-base');
      if (mlRepoInp && mlBaseInp) {
        mlRepoInp.addEventListener('input', () => {
          const m = mlRepoInp.value.trim().match(/\/(?:tree|blob|commits)\/([^/?#\s]+)/i);
          if (m && m[1]) {
            try {
              mlBaseInp.value = decodeURIComponent(m[1]);
            } catch (_) {
              mlBaseInp.value = m[1];
            }
          }
        });
      }

      body.querySelector('#ml-launch-btn').onclick = () => {
        const launchMode = modeSel.value;
        const collabEnabled = collabChk.checked;
        const githubEnabled = ghChk.checked;
        const githubRepo = body.querySelector('#ml-gh-repo').value.trim();
        const mlTokEl = body.querySelector('#ml-gh-token');
        const enteredToken = (mlTokEl?.value || '').trim();
        if (mlTokEl && enteredToken) {
          mlTokEl.value = '';
          runtime.hasVaultToken = true;
        }
        if (githubEnabled && !githubRepo) {
          showToast('Cole o link do repositório GitHub (https://github.com/...) ou usuario/repo!', 'error');
          return;
        }
        const config = {
          launchMode,
          autoEnableLoop: collabEnabled ? true : body.querySelector('#ml-autoloop').checked,
          autoGroup: body.querySelector('#ml-autogroup').checked,
          refuseThinkingModels: body.querySelector('#ml-refuse-thinking').checked,
          collabEnabled,
          collabProfile: body.querySelector('#ml-collab-profile').value,
          collabStopMode: body.querySelector('#ml-collab-stop').value,
          collabMirrorExternal: body.querySelector('#ml-collab-external').checked,
          githubEnabled,
          githubRepo,
          ...(enteredToken ? { githubToken: enteredToken } : {}),
          githubBaseBranch: body.querySelector('#ml-gh-base').value.trim() || 'main',
          githubAuthMode: body.querySelector('#ml-gh-auth').value,
          githubBranchMode: body.querySelector('#ml-gh-branch').value,
          tempFilesEnabled: body.querySelector('#ml-tf-enabled').checked
        };
        if (launchMode === 'swarm') {
          config.swarmCount = Number(body.querySelector('#ml-count').value || 3);
          config.basePrompt = body.querySelector('#ml-swarm-prompt').value.trim();
        } else if (launchMode === 'task_list') {
          config.tasks = body.querySelector('#ml-tasks-list').value.split('\n').map((s) => s.trim()).filter(Boolean);
        } else {
          config.template = body.querySelector('#ml-matrix-tpl').value.trim();
          config.variableName = body.querySelector('#ml-matrix-var').value.trim() || 'item';
          config.variableValues = body.querySelector('#ml-matrix-vals').value.split('\n').map((s) => s.trim()).filter(Boolean);
        }

        chrome.runtime.sendMessage({ type: 'AU_LAUNCH_MULTI_AGENT', config }, (res) => {
          if (res && res.ok) {
            if (res.roomId) {
              runtime.selectedDrawerRoomId = res.roomId;
              runtime.activeDrawerTab = 'collab';
              showToast(`🤝 Sala TempChat #${res.roomId} criada com ${res.launchedCount} Agents!`, 'success');
              renderDrawer();
            } else {
              showToast(`${res.launchedCount} chats Agent lançados em paralelo!`, 'success');
              loadLiveTabsInDrawer();
            }
          } else {
            showToast((res && res.error) || 'Preencha os campos para lançar.', 'error');
          }
        });
      };

      body.querySelector('#ml-join-open-btn').onclick = () => {
        const profile = body.querySelector('#ml-collab-profile').value;
        const stopMode = body.querySelector('#ml-collab-stop').value;
        const mirrorExternal = body.querySelector('#ml-collab-external').checked;
        const githubEnabled = ghChk.checked;
        const githubRepo = body.querySelector('#ml-gh-repo').value.trim();
        const mlTokEl = body.querySelector('#ml-gh-token');
        const enteredToken = (mlTokEl?.value || '').trim();
        if (mlTokEl && enteredToken) {
          mlTokEl.value = '';
          runtime.hasVaultToken = true;
        }
        chrome.runtime.sendMessage(
          {
            type: 'AU_COLLAB_CREATE_FROM_OPEN_TABS',
            options: {
              profile,
              stopMode,
              mirrorExternal,
              refuseThinkingModels: body.querySelector('#ml-refuse-thinking').checked,
              githubEnabled: Boolean(githubEnabled && githubRepo),
              githubRepo,
              ...(enteredToken ? { githubToken: enteredToken } : {}),
              githubBaseBranch: body.querySelector('#ml-gh-base').value.trim() || 'main',
              githubAuthMode: body.querySelector('#ml-gh-auth').value,
              githubBranchMode: body.querySelector('#ml-gh-branch').value
            }
          },
          (res) => {
            if (res && res.ok && res.room) {
              runtime.selectedDrawerRoomId = res.room.roomId;
              runtime.activeDrawerTab = 'collab';
              showToast(`🤝 Abas abertas unidas na Sala TempChat #${res.room.roomId}!`, 'success');
              renderDrawer();
            } else {
              showToast((res && res.error) || 'Abra pelo menos 1 aba do Arena.ai.', 'error');
            }
          }
        );
      };

      const loadLiveTabsInDrawer = () => {
        const box = body.querySelector('#ml-live-tabs');
        if (!box) return;
        chrome.runtime.sendMessage({ type: 'AU_GET_MISSION_CONTROL' }, (res) => {
          if (!res || !res.ok || !res.tabs.length) {
            box.innerHTML = '<div class="au-muted">Nenhuma aba ativa encontrada.</div>';
            return;
          }
          box.innerHTML = res.tabs
            .map(
              (t) => `
              <div class="au-queue-item" style="align-items:center;">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.title || 'Arena.ai')}</div>
                  <div class="au-muted">${t.status === 'token_stopped' ? '⚠️ Sem Tokens' : t.autoContinueEnabled ? `🟢 Ativo • ${t.loopsCount} loops` : '⚪ Pausado'}</div>
                </div>
                <button class="au-icon-btn ml-focus-tab" data-id="${t.tabId}">Ir</button>
              </div>
            `
            )
            .join('');
          box.querySelectorAll('.ml-focus-tab').forEach((b) => {
            b.onclick = () => chrome.runtime.sendMessage({ type: 'AU_CONTROL_TAB', tabId: Number(b.dataset.id), command: 'focus' });
          });
        });
      };

      body.querySelector('#ml-refresh-tabs').onclick = loadLiveTabsInDrawer;
      body.querySelector('#ml-pause-all').onclick = () => {
        chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'pause_all' }, () => {
          showToast('Todos os chats pausados.', 'info');
          loadLiveTabsInDrawer();
        });
      };
      body.querySelector('#ml-resume-all').onclick = () => {
        chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'resume_all' }, () => {
          showToast('Auto-Continue retomado em todas as abas!', 'success');
          loadLiveTabsInDrawer();
        });
      };
      body.querySelector('#ml-split-win').onclick = () => {
        chrome.runtime.sendMessage({ type: 'AU_SPLIT_ARENA_WINDOWS' }, (res) => {
          if (res && !res.ok) showToast(res.reason || 'Abra ao menos 2 abas.', 'error');
        });
      };

      loadLiveTabsInDrawer();
      return;
    }

    if (tab === 'collab') {
      clearDrawerCollabPoll();
      body.innerHTML = `
        <div class="au-card" id="tc-top-card">
          <div class="au-card-title">
            <span>🤝 Sala TempChat Multi-Agent</span>
            <button id="tc-new-from-open" class="au-icon-btn" title="Unir abas abertas numa nova sala TempChat">+ Unir Abas</button>
          </div>
          <div id="tc-room-bar" style="display:flex;flex-direction:column;gap:8px;">
            <div class="au-muted">Carregando salas TempChat...</div>
          </div>
        </div>

        <div class="au-card" id="tc-chat-card" style="display:none;gap:8px;">
          <div class="au-card-title">
            <span id="tc-feed-title">Mensagens em Tempo Real</span>
            <span id="tc-room-status-pill" class="au-badge">ATIVA</span>
          </div>
          <div id="tc-roster-box" style="display:flex;flex-wrap:wrap;gap:5px;"></div>
          <div id="tc-feed-list" style="display:flex;flex-direction:column;gap:7px;max-height:280px;overflow-y:auto;padding:8px;border-radius:8px;background:#0b0d12;border:1px solid #232732;"></div>
          <div class="au-row" style="gap:6px;">
            <input id="tc-coord-input" class="au-input" placeholder="Fale ao vivo com todos os Agents da sala..." style="flex:1;" />
            <button id="tc-coord-send" class="au-btn au-btn-primary">Enviar</button>
          </div>
        </div>

        <div class="au-card" id="tc-files-gh-card" style="display:none;gap:8px;border-color:rgba(139,92,246,0.38);">
          <div class="au-card-title">
            <span>📦 Arquivos Temp (4 Hosts) & GitHub</span>
            <button id="tc-sync-bin" class="au-icon-btn" title="Sincronizar bucket Filebin.net da sala">🔄 Bucket</button>
          </div>
          <div id="tc-gh-status-box" style="display:none;flex-direction:column;gap:5px;padding:7px 9px;border-radius:8px;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.3);font-size:11.5px;"></div>
          <div class="au-row" style="gap:6px;flex-wrap:wrap;">
            <input type="file" id="tc-upload-input" style="display:none;" />
            <select id="tc-upload-provider" class="au-select" style="flex:1;min-width:130px;">
              <option value="filebin">Filebin.net (+ Auto-Fallback)</option>
              <option value="litterbox">Litterbox Catbox (+ Fallback)</option>
              <option value="uguu">Uguu.se (+ Fallback)</option>
              <option value="x0at">x0.at (+ Fallback)</option>
            </select>
            <button id="tc-upload-btn" class="au-btn" title="Enviar arquivo do seu PC para todos os Agents da sala">📤 Enviar Arquivo</button>
            <a id="tc-open-filebin" href="#" target="_blank" rel="noopener" class="au-icon-btn" style="text-decoration:none;" title="Abrir pasta compartilhada no Filebin.net">🗂️ Filebin</a>
          </div>
          <div id="tc-files-list" style="display:flex;flex-direction:column;gap:5px;max-height:150px;overflow-y:auto;"></div>
        </div>

        <div class="au-card" id="tc-final-card" style="display:none;border-color:rgba(16,185,129,0.5);">
          <div class="au-card-title">
            <span style="color:#6ee7b7;">✅ Entrega Final Consolidada</span>
            <button id="tc-copy-final" class="au-icon-btn">Copiar</button>
          </div>
          <div id="tc-final-by" class="au-muted"></div>
          <pre id="tc-final-text" style="margin:0;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11.5px;background:#0b0d12;padding:8px;border-radius:8px;border:1px solid #232732;color:#e4e4e7;"></pre>
        </div>
      `;

      let lastRenderedRoomSig = '';
      let currentRoomObj = null;

      const refreshCollabDrawer = async (forceRender = false) => {
        if (!runtime.drawerOpen || runtime.activeDrawerTab !== 'collab') {
          clearDrawerCollabPoll();
          return;
        }
        const res = await sendBgMessage({ type: 'AU_COLLAB_GET_ROOMS' });
        const rooms = (res && Array.isArray(res.rooms)) ? res.rooms : [];
        const roomBar = body.querySelector('#tc-room-bar');
        const chatCard = body.querySelector('#tc-chat-card');
        const filesGhCard = body.querySelector('#tc-files-gh-card');
        const finalCard = body.querySelector('#tc-final-card');
        if (!roomBar || !chatCard || !finalCard) return;

        if (!rooms.length) {
          lastRenderedRoomSig = 'empty';
          chatCard.style.display = 'none';
          if (filesGhCard) filesGhCard.style.display = 'none';
          finalCard.style.display = 'none';
          roomBar.innerHTML = `
            <div class="au-muted">
              Nenhuma sala TempChat ativa no momento. Ative o <strong>Modo Colaboração</strong> ao lançar um lote Multi-Agent ou una suas abas abertas agora mesmo!
            </div>
            <div class="au-row">
              <button id="tc-go-launcher" class="au-btn au-btn-primary" style="flex:1;">🚀 Ir para Multi-Agent</button>
              <button id="tc-quick-unite" class="au-btn" style="flex:1;">🔗 Unir Abas Abertas</button>
              <button id="tc-empty-livechat" class="au-btn" style="flex:1;border-color:rgba(6,182,212,0.55);color:#67e8f9;">⚡ Chat Live ↗</button>
            </div>
          `;
          roomBar.querySelector('#tc-go-launcher').onclick = () => {
            runtime.activeDrawerTab = 'multi';
            renderDrawer();
          };
          roomBar.querySelector('#tc-quick-unite').onclick = () => {
            body.querySelector('#tc-new-from-open').click();
          };
          roomBar.querySelector('#tc-empty-livechat').onclick = () => {
            chrome.runtime.sendMessage({ type: 'AU_OPEN_LIVECHAT' });
          };
          return;
        }

        const targetId =
          (runtime.selectedDrawerRoomId && rooms.some((r) => r.roomId === runtime.selectedDrawerRoomId) && runtime.selectedDrawerRoomId) ||
          (runtime.collabRoomId && rooms.some((r) => r.roomId === runtime.collabRoomId) && runtime.collabRoomId) ||
          rooms[0].roomId;
        runtime.selectedDrawerRoomId = targetId;
        const room = rooms.find((r) => r.roomId === targetId) || rooms[0];
        currentRoomObj = room;

        const intSt = room.integrationStatus || {};
        const boardRev = room.sharedBoard ? Number(room.sharedBoard.revision || 1) : 1;
        const sig = `${rooms.length}|${room.roomId}|${room.seq}|${room.status}|${room.stopMode}|${room.externalCode}|${boardRev}|${intSt.state || ''}|${Math.floor(Number(intSt.remainingMs || 0) / 15000)}|${room.dedupDroppedCount || 0}|${room.thinkingRefusalsCount || 0}|${Boolean(room.finalDeliverable)}|${(room.sharedFiles || []).length}|${room.githubConfig ? `${room.githubConfig.commitsPushed}|${room.githubConfig.pullRequestUrl}` : ''}|${(room.agents || []).map((a) => `${a.tabId}:${a.liveStatus}:${a.loopsCount}:${a.admittedToTeam ? 1 : 0}:${a.screeningStatus || ''}:${a.githubAccessLevel || ''}:${a.refusedCount || 0}`).join(',')}`;
        if (!forceRender && sig === lastRenderedRoomSig) return;
        lastRenderedRoomSig = sig;

        chatCard.style.display = 'flex';
        if (filesGhCard) filesGhCard.style.display = 'flex';
        const remMin = Math.max(0, Math.ceil(Number(intSt.remainingMs || 0) / 60000));
        const contractsCnt = room.sharedBoard ? Object.keys(room.sharedBoard.contracts || {}).length : 0;
        roomBar.innerHTML = `
          <div class="au-row" style="justify-content:space-between;">
            <select id="tc-room-select" class="au-select" style="flex:1;">
              ${rooms
                .map(
                  (r) =>
                    `<option value="${escapeHtml(r.roomId)}" ${r.roomId === room.roomId ? 'selected' : ''}>Sala #${escapeHtml(r.roomId)} (${(r.agents || []).length} agentes • ${r.status === 'completed' ? 'Concluída' : 'Ativa'})</option>`
                )
                .join('')}
            </select>
            <button id="tc-open-livechat" class="au-btn" style="border-color:rgba(6,182,212,0.6);color:#67e8f9;" title="Abrir nova guia dedicada Chat Live da extensão">
              ⚡ Chat Live ↗
            </button>
            <button id="tc-open-ext" class="au-btn" title="Abrir/espelhar sala no site tempchat.online real">
              🌐 ${room.externalCode ? `tempchat #${escapeHtml(room.externalCode)}` : 'tempchat.online'}
            </button>
          </div>
          <div class="au-row" style="justify-content:space-between;">
            <select id="tc-stop-mode" class="au-select" style="flex:1;">
              <option value="smart_consensus" ${room.stopMode === 'smart_consensus' ? 'selected' : ''}>Parada Inteligente (Entrega Final)</option>
              <option value="endless_tokens" ${room.stopMode === 'endless_tokens' ? 'selected' : ''}>Refinar até Esgotar Tokens</option>
            </select>
            <button id="tc-close-room" class="au-icon-btn" title="Encerrar esta sala TempChat">Encerrar</button>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;border-radius:8px;background:rgba(6,182,212,0.09);border:1px solid rgba(6,182,212,0.35);font-size:11px;">
            <span style="color:#67e8f9;font-weight:600;">${escapeHtml(intSt.label || '🟢 Em Colaboração')} • Prontos: ${intSt.readyCount || 0}/${intSt.totalActive || 0} • SLA: ${remMin}m • Contratos: ${contractsCnt} • Dedup: ${room.dedupDroppedCount || 0}</span>
            <div class="au-row" style="gap:4px;">
              <button id="tc-sla-add10" class="au-icon-btn" style="font-size:10.5px;">+10m</button>
              <button id="tc-sla-force" class="au-icon-btn" style="font-size:10.5px;border-color:rgba(16,185,129,0.5);color:#6ee7b7;">🎯 Liberar</button>
            </div>
          </div>
        `;

        roomBar.querySelector('#tc-sla-add10').onclick = async () => {
          await sendBgMessage({ type: 'AU_COLLAB_SET_INTEGRATION_SLA', roomId: room.roomId, addMinutes: 10 });
          showToast('⏱️ +10m no prazo de Integração Final!', 'success');
          refreshCollabDrawer(true);
        };
        roomBar.querySelector('#tc-sla-force').onclick = async () => {
          await sendBgMessage({ type: 'AU_COLLAB_SET_INTEGRATION_SLA', roomId: room.roomId, forceReady: true });
          showToast('🎯 Integração Final liberada!', 'success');
          refreshCollabDrawer(true);
        };

        roomBar.querySelector('#tc-room-select').onchange = (e) => {
          runtime.selectedDrawerRoomId = e.target.value;
          refreshCollabDrawer(true);
        };
        roomBar.querySelector('#tc-stop-mode').onchange = async (e) => {
          await sendBgMessage({
            type: 'AU_COLLAB_SET_ROOM_STATE',
            roomId: room.roomId,
            stopMode: e.target.value
          });
          showToast('Modo de conclusão da sala atualizado!', 'success');
          refreshCollabDrawer(true);
        };
        roomBar.querySelector('#tc-open-livechat').onclick = () => {
          chrome.runtime.sendMessage({
            type: 'AU_OPEN_LIVECHAT',
            roomId: room.roomId
          });
        };
        roomBar.querySelector('#tc-open-ext').onclick = async () => {
          await sendBgMessage({
            type: 'AU_COLLAB_SET_ROOM_STATE',
            roomId: room.roomId,
            openExternalBridge: true,
            focusExternalTab: true
          });
          showToast('Abrindo ponte ao vivo no tempchat.online!', 'info');
        };
        roomBar.querySelector('#tc-close-room').onclick = async () => {
          await sendBgMessage({
            type: 'AU_COLLAB_SET_ROOM_STATE',
            roomId: room.roomId,
            status: 'closed'
          });
          if (runtime.collabRoomId === room.roomId) {
            runtime.collabRoomId = '';
            runtime.collabAgentName = '';
          }
          runtime.selectedDrawerRoomId = '';
          renderToolbarAndDrawerStatus();
          refreshCollabDrawer(true);
        };

        const stPill = body.querySelector('#tc-room-status-pill');
        if (stPill) {
          stPill.textContent =
            room.status === 'completed'
              ? '✅ CONSENSO PRONTO'
              : room.status === 'paused'
                ? '⏸ PAUSADA'
                : `🟢 ATIVA • #${room.roomId}`;
        }

        const rosterBox = body.querySelector('#tc-roster-box');
        if (rosterBox) {
          const allAgents = room.agents || [];
          const admittedCnt = allAgents.filter((a) => a.admittedToTeam !== false && !a.closed).length;
          const screeningCnt = allAgents.filter((a) => a.admittedToTeam === false && !a.closed).length;
          const gateHeader =
            room.refuseThinkingModels !== false && (screeningCnt > 0 || (room.thinkingRefusalsCount || 0) > 0)
              ? `<div style="width:100%;font-size:10.5px;color:#fda4af;margin-bottom:2px;">🛡️ Filtro Sem-Thinking: <strong>${admittedCnt}/${allAgents.length}</strong> no Time${screeningCnt > 0 ? ` • ${screeningCnt} em triagem` : ''}${room.thinkingRefusalsCount ? ` • ${room.thinkingRefusalsCount} Thinking recusado(s)` : ''}</div>`
              : '';
          rosterBox.innerHTML =
            gateHeader +
            allAgents
              .map((ag) => {
                const isAdmitted = ag.admittedToTeam !== false;
                const dot = ag.closed
                  ? '⚫'
                  : !isAdmitted
                    ? ag.screeningStatus === 'refused_stopped'
                      ? '🚫'
                      : '🔍'
                    : ag.liveStatus === 'generating'
                      ? '🟢'
                      : ag.liveStatus === 'token_stopped'
                        ? '🔴'
                        : '✅';
                const statusHint = !isAdmitted
                  ? ag.screeningStatus === 'rerolling'
                    ? `Sorteando modelo sem Thinking (#${ag.refusedCount || 1} recusado)`
                    : ag.screeningStatus === 'refused_stopped'
                      ? 'Recusado por Thinking'
                      : 'Triagem Sem-Thinking antes de entrar no Time'
                  : 'Admitido no Time (Sem Thinking)';
                const extraTag = !isAdmitted
                  ? ag.refusedCount
                    ? ` (🔄#${ag.refusedCount})`
                    : ' (Triagem)'
                  : '';
                return `<button class="au-icon-btn tc-focus-ag" data-tab="${ag.tabId}" title="${escapeHtml(statusHint)} — Ir para aba de ${escapeHtml(ag.name)}" style="font-size:11px;${!isAdmitted ? 'border-color:rgba(244,63,94,0.45);color:#fda4af;' : 'border-color:rgba(16,185,129,0.4);'}">${dot} ${escapeHtml(ag.name)}${escapeHtml(extraTag)}</button>`;
              })
              .join('');
          rosterBox.querySelectorAll('.tc-focus-ag').forEach((btn) => {
            btn.onclick = () => {
              chrome.runtime.sendMessage({
                type: 'AU_CONTROL_TAB',
                tabId: Number(btn.dataset.tab),
                command: 'focus'
              });
            };
          });
        }

        const feedEl = body.querySelector('#tc-feed-list');
        if (feedEl) {
          const wasNearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 65;
          const msgs = (room.messages || []).filter(
            (m) =>
              m &&
              (m.senderType !== 'system' ||
                String(m.senderName || '').includes('Radar Git') ||
                String(m.senderName || '').includes('Integração Final')) &&
              !isAutoOrSystemPromptText(m.text)
          );
          feedEl.innerHTML = msgs.length
            ? msgs
                .map((m) => {
                  const isUser = m.senderType === 'user' || m.senderType === 'external';
                  const isSys = m.senderType === 'system';
                  const borderCol = isSys
                    ? 'rgba(139,92,246,0.45)'
                    : isUser
                      ? 'rgba(16,185,129,0.5)'
                      : 'rgba(6,182,212,0.4)';
                  const bgCol = isSys
                    ? 'rgba(139,92,246,0.1)'
                    : isUser
                      ? 'rgba(16,185,129,0.1)'
                      : 'rgba(6,182,212,0.08)';
                  const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                  return `
                    <div style="border:1px solid ${borderCol};background:${bgCol};border-radius:8px;padding:7px 9px;font-size:11.5px;">
                      <div style="display:flex;justify-content:space-between;margin-bottom:3px;font-weight:700;color:${isUser ? '#6ee7b7' : isSys ? '#c4b5fd' : '#67e8f9'};">
                        <span>${escapeHtml(m.senderName)}</span>
                        <span style="font-weight:400;color:#71717a;font-size:10px;">${escapeHtml(timeStr)}</span>
                      </div>
                      <div style="white-space:pre-wrap;word-break:break-word;color:#e4e4e7;line-height:1.42;">${escapeHtml(m.text)}</div>
                    </div>
                  `;
                })
                .join('')
            : '<div class="au-muted">Aguardando o primeiro turno dos Agents para compartilhar descobertas aqui...</div>';
          if (wasNearBottom) {
            feedEl.scrollTop = feedEl.scrollHeight;
          }
        }

        // Render Shared Temp Files + GitHub Room Status
        const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '#');
        const fbLink = body.querySelector('#tc-open-filebin');
        if (fbLink && room.filebinUrl) {
          fbLink.href = safeUrl(room.filebinUrl);
          fbLink.style.display = 'inline-flex';
        }
        const ghBox = body.querySelector('#tc-gh-status-box');
        if (ghBox) {
          if (room.githubConfig && room.githubConfig.enabled && room.githubConfig.repo) {
            const gh = room.githubConfig;
            const ghHref = safeUrl(/^https?:\/\//i.test(gh.repo) ? gh.repo : `https://github.com/${gh.repo}`);
            const ghLabel = gh.fullName || gh.repo.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '');
            const modeTxt =
              gh.authMode === 'vault_broker_zero_token'
                ? '🔐 Cofre Zero-Token no Prompt'
                : gh.authMode === 'extension_proxy_push'
                  ? 'Push Seguro via Extensão'
                  : 'Git Direto nos Agents';
            ghBox.style.display = 'flex';
            ghBox.innerHTML = `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
                <a href="${escapeHtml(ghHref)}" target="_blank" rel="noopener" style="color:#c4b5fd;font-weight:700;text-decoration:none;">🐙 ${escapeHtml(ghLabel)} (${escapeHtml(gh.baseBranch || 'main')})</a>
                <button class="au-icon-btn" id="tc-push-this-ws" title="Enviar o Workspace desta aba para o GitHub da sala">⬆ Push Aba</button>
              </div>
              <div class="au-muted" style="font-size:11px;">
                Modo: ${modeTxt} • ${gh.branchMode === 'single_shared_branch' ? 'Branch Compartilhada' : 'Branch por Agente + PR'}
                ${gh.commitsPushed ? ` • ${gh.commitsPushed} push(es)` : ''}
                ${gh.lastCommitUrl ? ` • <a href="${escapeHtml(safeUrl(gh.lastCommitUrl))}" target="_blank" rel="noopener" style="color:#93c5fd;">Commit</a>` : ''}
                ${gh.pullRequestUrl ? ` • <a href="${escapeHtml(safeUrl(gh.pullRequestUrl))}" target="_blank" rel="noopener" style="color:#6ee7b7;font-weight:700;">Ver PR</a>` : ''}
              </div>
            `;
            const pushWsBtn = ghBox.querySelector('#tc-push-this-ws');
            if (pushWsBtn) {
              pushWsBtn.onclick = async () => {
                pushWsBtn.disabled = true;
                pushWsBtn.textContent = 'Enviando...';
                const isSingleBranch = gh.branchMode === 'single_shared_branch';
                const out = await sendBgMessage({
                  type: 'AU_GITHUB_PUSH_BUNDLE',
                  roomId: room.roomId,
                  repo: gh.repo,
                  baseBranch: gh.baseBranch || 'main',
                  branch: isSingleBranch
                    ? gh.sharedBranch || `arena/sala-${room.roomId}`
                    : runtime.githubBranch || `au/${room.roomId}/push-${Date.now().toString(36)}`,
                  openPR: !isSingleBranch,
                  message: `feat(sala-${room.roomId}): push do workspace da aba`
                });
                pushWsBtn.disabled = false;
                pushWsBtn.textContent = '⬆ Push Aba';
                if (out && out.ok) {
                  const prNote = out.pullRequest && out.pullRequest.number ? ` • PR #${out.pullRequest.number} aberto!` : '';
                  showToast(`✅ Commit ${out.shortSha} enviado para ${out.repo}@${out.branch}${prNote}`, 'success');
                  refreshCollabDrawer(true);
                } else {
                  showToast((out && out.error) || 'Abra uma sessão Agent salva para enviar o Workspace.', 'error');
                }
              };
            }
          } else {
            ghBox.style.display = 'none';
          }
        }

        const filesListEl = body.querySelector('#tc-files-list');
        if (filesListEl) {
          const sFiles = (room.sharedFiles || []).slice().reverse();
          filesListEl.innerHTML = sFiles.length
            ? sFiles
                .map(
                  (f) => `
                  <div class="au-queue-item" style="align-items:center;padding:5px 8px;">
                    <div style="flex:1;min-width:0;">
                      <div style="font-weight:600;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📄 ${escapeHtml(f.filename || 'arquivo')}</div>
                      <div class="au-muted" style="font-size:10.5px;">${escapeHtml(f.provider || 'TempHost')} • por ${escapeHtml(f.uploadedBy || 'Agente')}</div>
                    </div>
                    <a href="${escapeHtml(safeUrl(f.url))}" target="_blank" rel="noopener" class="au-icon-btn" style="text-decoration:none;">⬇</a>
                    ${
                      (settings.githubDefaultRepo || (room.githubConfig && room.githubConfig.repo))
                        ? `<button class="au-icon-btn tc-push-file-gh" data-url="${escapeHtml(f.url)}" data-name="${escapeHtml(f.filename || '')}" title="Descompactar (se .zip) e fazer commit no GitHub">🐙</button>`
                        : ''
                    }
                  </div>
                `
                )
                .join('')
            : '<div class="au-muted" style="font-size:11px;">Nenhum arquivo trocado ainda. Envie arquivos acima ou deixe os Agents usarem <code>au_upload</code> (Filebin/Litterbox/Uguu/x0.at).</div>';

          filesListEl.querySelectorAll('.tc-push-file-gh').forEach((btn) => {
            btn.onclick = async () => {
              const targetRepo = (room.githubConfig && room.githubConfig.repo) || settings.githubDefaultRepo;
              if (!targetRepo) return;
              btn.disabled = true;
              btn.textContent = '⏳';
              const out = await sendBgMessage({
                type: 'AU_GITHUB_PUSH_BUNDLE',
                roomId: room.roomId,
                repo: targetRepo,
                baseBranch: (room.githubConfig && room.githubConfig.baseBranch) || settings.githubBaseBranch || 'main',
                branch:
                  room.githubConfig && room.githubConfig.branchMode === 'single_shared_branch'
                    ? room.githubConfig.sharedBranch || `arena/sala-${room.roomId}`
                    : `arena/sala-${room.roomId}`,
                archiveUrl: btn.dataset.url,
                filename: btn.dataset.name,
                openPR: Boolean(room.githubConfig && room.githubConfig.branchMode === 'branch_per_agent_pr'),
                message: `feat(sala-${room.roomId}): importa artefato compartilhado ${btn.dataset.name}`
              });
              btn.disabled = false;
              btn.textContent = '🐙';
              if (out && out.ok) {
                showToast(`✅ Enviado p/ ${out.repo}@${out.branch} (${out.filesCount} arq • ${out.shortSha})!`, 'success');
                refreshCollabDrawer(true);
              } else {
                showToast((out && out.error) || 'Erro ao enviar ao GitHub.', 'error');
              }
            };
          });
        }

        if (room.finalDeliverable) {
          finalCard.style.display = 'flex';
          body.querySelector('#tc-final-by').textContent = `Consolidado por ${room.finalBy || 'Sintetizador'}`;
          body.querySelector('#tc-final-text').textContent = room.finalDeliverable;
        } else {
          finalCard.style.display = 'none';
        }
      };

      const sendCoord = async () => {
        const inp = body.querySelector('#tc-coord-input');
        if (!inp || !currentRoomObj) return;
        const txt = inp.value.trim();
        if (!txt) return;
        inp.value = '';
        await sendBgMessage({
          type: 'AU_COLLAB_SEND_COORDINATOR_MSG',
          roomId: currentRoomObj.roomId,
          text: txt,
          wakeAgents: true
        });
        showToast('Mensagem enviada para todos os Agents da sala!', 'success');
        refreshCollabDrawer(true);
      };

      body.querySelector('#tc-coord-send').onclick = sendCoord;
      body.querySelector('#tc-coord-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendCoord();
        }
      });
      body.querySelector('#tc-new-from-open').onclick = async () => {
        const res = await sendBgMessage({
          type: 'AU_COLLAB_CREATE_FROM_OPEN_TABS',
          options: {
            profile: settings.collabDefaultProfile || 'specialists',
            stopMode: settings.collabDefaultStopMode || 'smart_consensus',
            mirrorExternal: Boolean(settings.collabMirrorExternalTempChat),
            refuseThinkingModels: settings.refuseThinkingModels !== false,
            githubEnabled: Boolean(settings.githubEnabledInCollab && settings.githubDefaultRepo),
            githubRepo: settings.githubDefaultRepo || '',
            githubBaseBranch: settings.githubBaseBranch || 'main',
            githubAuthMode: AU_DEFAULTS.normalizeGithubAuthMode(settings.githubAuthMode),
            githubBranchMode: settings.githubBranchMode || 'branch_per_agent_pr',
            githubDefaultAgentAccessMode: settings.githubDefaultAgentAccessMode || 'auto_role',
            collabIntegrationTimeoutMinutes: Number(settings.collabIntegrationTimeoutMinutes || 25)
          }
        });
        if (res && res.ok && res.room) {
          runtime.selectedDrawerRoomId = res.room.roomId;
          showToast(`🤝 Sala TempChat #${res.room.roomId} criada com suas abas abertas!`, 'success');
          refreshCollabDrawer(true);
        } else {
          showToast((res && res.error) || 'Não foi possível criar sala.', 'error');
        }
      };
      body.querySelector('#tc-sync-bin').onclick = async () => {
        if (!currentRoomObj) return;
        const btn = body.querySelector('#tc-sync-bin');
        btn.disabled = true;
        const out = await sendBgMessage({
          type: 'AU_TEMPFILE_SYNC_ROOM_BIN',
          roomId: currentRoomObj.roomId
        });
        btn.disabled = false;
        if (out && out.ok) {
          showToast(out.added ? `📦 ${out.added} novo(s) arquivo(s) sincronizado(s) do Filebin!` : 'Bucket Filebin sincronizado!', 'success');
          refreshCollabDrawer(true);
        }
      };

      const upInput = body.querySelector('#tc-upload-input');
      const upBtn = body.querySelector('#tc-upload-btn');
      upBtn.onclick = () => upInput.click();
      upInput.onchange = () => {
        const file = upInput.files && upInput.files[0];
        if (!file || !currentRoomObj) return;
        upBtn.disabled = true;
        upBtn.textContent = '📤 Enviando...';
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = String(reader.result || '');
          const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          const provider = body.querySelector('#tc-upload-provider').value;
          const out = await sendBgMessage({
            type: 'AU_TEMPFILE_UPLOAD',
            roomId: currentRoomObj.roomId,
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            base64Data,
            primaryProvider: provider,
            autoFallback: true
          });
          upBtn.disabled = false;
          upBtn.textContent = '📤 Enviar Arquivo';
          upInput.value = '';
          if (out && out.ok) {
            showToast(`📦 ${file.name} enviado via ${out.providerLabel} e anunciado aos Agents!`, 'success');
            refreshCollabDrawer(true);
          } else {
            showToast((out && out.error) || 'Falha no upload temporário.', 'error');
          }
        };
        reader.readAsDataURL(file);
      };

      body.querySelector('#tc-copy-final').onclick = () => {
        if (currentRoomObj && currentRoomObj.finalDeliverable) {
          navigator.clipboard.writeText(currentRoomObj.finalDeliverable).catch(() => {});
          showToast('Entrega Final copiada!', 'success');
        }
      };

      refreshCollabDrawer(true);
      drawerCollabPollTimer = setInterval(() => refreshCollabDrawer(false), 2000);
      return;
    }

    if (tab === 'github') {
      const isSavedAgent =
        /\/agent\/[a-zA-Z0-9_-]+/i.test(location.pathname) ||
        (/\/c\/[a-zA-Z0-9_-]+/i.test(location.pathname) && detectCurrentArenaMode() === 'agent');
      const quickTokUrl =
        'https://github.com/settings/tokens/new?scopes=repo,workflow,project&description=Arena+Ultra+Autonomous+PR';
      body.innerHTML = `
        <div class="au-card" style="border-color:rgba(16,185,129,0.45);">
          <div class="au-card-title">
            <span style="color:#6ee7b7;">🐙 GitHub Autônomo & Cofre Zero-Token</span>
            <div class="au-row" style="gap:5px;flex-wrap:wrap;">
              <a href="${quickTokUrl}" target="_blank" rel="noopener" class="au-icon-btn" style="text-decoration:none;border-color:rgba(245,158,11,0.5);color:#fcd34d;" title="Abrir GitHub já com permissões repo + workflow marcadas para PRs automáticos!">🔑 Gerar Token</a>
              <button id="ghd-inspect-btn" class="au-icon-btn" style="border-color:rgba(6,182,212,0.5);color:#67e8f9;" title="Auditar escopos, permissões e validade da credencial">🛡️ Escopos</button>
              <button id="ghd-revoke-btn" class="au-icon-btn" style="border-color:rgba(244,63,94,0.5);color:#fda4af;" title="Revogar Cofre GitHub imediatamente">🚫 Revogar</button>
              <button id="ghd-test-btn" class="au-icon-btn" style="border-color:rgba(16,185,129,0.5);color:#6ee7b7;">🔍 Testar Link</button>
            </div>
          </div>
          <div class="au-muted" style="font-size:11.3px;">
            Cole o link do seu repositório (ex.: <code>https://github.com/nadabgfccvd/My-Path</code>). No modo <strong>Cofre Zero-Token</strong>, o PAT nunca entra no prompt do Agent!
          </div>
          <div class="au-row">
            <input id="ghd-repo" class="au-input" value="${escapeHtml(settings.githubDefaultRepo || '')}" placeholder="Cole o link: https://github.com/usuario/projeto" style="flex:1;" />
            <input id="ghd-branch" class="au-input" value="${escapeHtml(settings.githubBaseBranch || 'main')}" placeholder="main" style="width:82px;" title="Branch base (main / master)" />
          </div>
          <input id="ghd-token" type="password" autocomplete="off" class="au-input" value="" placeholder="${runtime.hasVaultToken ? '🔒 Token já ativo no Cofre de Sessão (deixe vazio p/ usar o atual ou cole novo)' : '🔑 Token PAT p/ salvar no Cofre de Sessão (nunca entra no prompt ou disco!)'}" />
          <div id="ghd-token-health" style="display:none;padding:6px 8px;border-radius:8px;font-size:11px;line-height:1.45;border:1px solid rgba(6,182,212,0.4);background:rgba(6,182,212,0.08);"></div>
          <select id="ghd-auth" class="au-select">
            <option value="vault_broker_zero_token" ${!settings.githubAuthMode || settings.githubAuthMode === 'vault_broker_zero_token' ? 'selected' : ''}>Modo: 🔐 Cofre Zero-Token no Prompt (Broker + CAS • Recomendado!)</option>
            <option value="extension_proxy_push" ${settings.githubAuthMode === 'extension_proxy_push' ? 'selected' : ''}>Modo: Push & PR Automático via Extensão (Sem expor PAT)</option>
          </select>
          <label class="au-row" style="cursor:pointer;font-size:11.8px;color:#6ee7b7;font-weight:600;">
            <input id="ghd-auto-pr" type="checkbox" ${settings.githubAutoCreatePR !== false ? 'checked' : ''} />
            <span>🚀 Criar/Atualizar Pull Requests Direto sem Você no Loop</span>
          </label>
          <div id="ghd-status" style="display:none;padding:7px 9px;border-radius:8px;font-size:11.3px;line-height:1.45;"></div>
          <textarea id="ghd-task" class="au-textarea" placeholder="O que este Agent deve fazer no repositório? (Ex: Continue o projeto, revise Issues/Actions e abra PRs direto sem mim no loop...)"></textarea>
          <button id="ghd-connect-btn" class="au-btn au-btn-primary">🚀 Conectar Repositório & Ativar Auto-PR nesta Aba</button>
        </div>

        <div class="au-card" style="border-color:rgba(139,92,246,0.4);">
          <div class="au-card-title">
            <span style="color:#c4b5fd;">📤 Enviar Workspace desta Aba → Commit / PR Agora</span>
          </div>
          <div class="au-muted" style="font-size:11.5px;">
            ${
              isSavedAgent
                ? 'Baixa o <code>/download-workspace</code> desta sessão e cria Commit + Pull Request no seu GitHub em 1 clique.'
                : 'Assim que o Agent criar arquivos nesta sessão (<code>/agent/...</code>), use este botão para abrir Commit/PR em 1 clique.'
            }
          </div>
          <input id="ghd-commit-msg" class="au-input" placeholder="Mensagem do commit/PR (ex: feat: entrega autônoma do Arena Agent)" />
          <label class="au-row au-muted" style="cursor:pointer;font-size:11.5px;">
            <input id="ghd-open-pr" type="checkbox" checked />
            <span>Criar branch dedicada automaticamente e abrir Pull Request</span>
          </label>
          <button id="ghd-push-ws-btn" class="au-btn" ${!isSavedAgent ? 'disabled style="opacity:0.55;"' : 'style="border-color:rgba(139,92,246,0.6);color:#c4b5fd;"'}>
            ⬆ Criar Commit & Pull Request Agora
          </button>
        </div>
      `;

      const repoInp = body.querySelector('#ghd-repo');
      const branchInp = body.querySelector('#ghd-branch');
      const tokInp = body.querySelector('#ghd-token');
      const authSel = body.querySelector('#ghd-auth');
      const autoPrChk = body.querySelector('#ghd-auto-pr');
      const stBox = body.querySelector('#ghd-status');

      repoInp.addEventListener('input', () => {
        const m = repoInp.value.trim().match(/\/(?:tree|blob|commits)\/([^/?#\s]+)/i);
        if (m && m[1]) {
          try {
            branchInp.value = decodeURIComponent(m[1]);
          } catch (_) {
            branchInp.value = m[1];
          }
        }
      });

      const persistQuickGh = async () => {
        const enteredTok = tokInp.value.trim();
        if (enteredTok) {
          tokInp.value = '';
          runtime.hasVaultToken = true;
          await sendBgMessage({
            type: 'AU_VAULT_SET_SECRET',
            key: 'githubToken',
            value: enteredTok
          });
        }
        settings = await AU_STORAGE.saveSettings({
          githubDefaultRepo: repoInp.value.trim(),
          githubBaseBranch: branchInp.value.trim() || 'main',
          githubAuthMode: AU_DEFAULTS.normalizeGithubAuthMode(authSel.value),
          githubAutoCreatePR: autoPrChk.checked
        });
      };
      [repoInp, branchInp, tokInp, authSel, autoPrChk].forEach((el) => el.addEventListener('change', persistQuickGh));

      const healthBox = body.querySelector('#ghd-token-health');
      const inspectDrawerToken = async (silent = false) => {
        if (!healthBox) return;
        const tokVal = tokInp.value.trim();
        if (!tokVal && !runtime.hasVaultToken) return;
        if (tokVal) await persistQuickGh();
        const info = await sendBgMessage({
          type: 'AU_GITHUB_INSPECT_TOKEN',
          repo: repoInp.value.trim()
        });
        if (!info) return;
        healthBox.style.display = 'block';
        if (info.ok && info.valid) {
          const vs = info.vaultSession || {};
          const exp = info.expiration || {};
          const scTxt = (info.scopes || []).length ? info.scopes.join(', ') : info.tokenTypeLabel || 'PAT';
          healthBox.style.color = '#6ee7b7';
          healthBox.innerHTML = `✅ <strong>@${escapeHtml(info.login || 'GitHub')}</strong> (${escapeHtml(info.tokenTypeLabel || 'PAT')}) • <strong>${escapeHtml(exp.label || 'Ativa')}</strong><br/><span style="color:#67e8f9;">Escopos: ${escapeHtml(scTxt)}${vs.remainingMinutes != null ? ` • Sessão Cofre: ${vs.remainingMinutes}m` : ''}</span>`;
          if (!silent) showToast(`🛡️ Credencial auditada: ${exp.label || 'Válida'}!`, 'success');
        } else {
          healthBox.style.color = '#fca5a5';
          healthBox.textContent = `⚠️ ${(info && info.error) || 'Credencial inválida ou Cofre revogado.'}`;
          if (!silent) showToast((info && info.error) || 'Credencial inválida.', 'error');
        }
      };

      if (runtime.hasVaultToken) {
        inspectDrawerToken(true);
      }

      const inspectBtn = body.querySelector('#ghd-inspect-btn');
      if (inspectBtn) {
        inspectBtn.onclick = async () => {
          await persistQuickGh();
          await inspectDrawerToken(false);
        };
      }

      const revokeBtn = body.querySelector('#ghd-revoke-btn');
      if (revokeBtn) {
        revokeBtn.onclick = async () => {
          const out = await sendBgMessage({ type: 'AU_GITHUB_REVOKE_VAULT', clearSaved: true });
          if (out && out.ok) {
            tokInp.value = '';
            runtime.hasVaultToken = false;
            if (healthBox) {
              healthBox.style.display = 'block';
              healthBox.style.color = '#fda4af';
              healthBox.textContent = '🚫 Cofre revogado imediatamente! Nenhum agente tem acesso à credencial.';
            }
            showToast('🚫 Cofre GitHub revogado e chaves dos agentes rotacionadas!', 'success');
          }
        };
      }

      body.querySelector('#ghd-test-btn').onclick = async () => {
        await persistQuickGh();
        const repo = repoInp.value.trim();
        if (!repo) {
          showToast('Cole o link do repositório GitHub primeiro!', 'error');
          return;
        }
        const btn = body.querySelector('#ghd-test-btn');
        btn.disabled = true;
        btn.textContent = 'Testando...';
        const res = await sendBgMessage({
          type: 'AU_GITHUB_CHECK_REPO_ACCESS',
          repo,
          token: tokInp.value.trim(),
          saveAsDefault: true
        });
        btn.disabled = false;
        btn.textContent = '🔍 Testar Link';
        stBox.style.display = 'block';
        if (res && res.ok) {
          if (res.htmlUrl) repoInp.value = res.htmlUrl;
          const detBr = res.branchFromUrl || res.defaultBranch || 'main';
          branchInp.value = detBr;
          if (res.canCreatePR) {
            stBox.style.background = 'rgba(16,185,129,0.14)';
            stBox.style.border = '1px solid rgba(16,185,129,0.45)';
            stBox.style.color = '#6ee7b7';
            const wfNote = res.hasWorkflowScope === false ? ' • ⚠️ Falta escopo workflow p/ .github/workflows' : ' • ⚙️ Workflows OK';
            stBox.textContent = `✅ ${res.fullName} (branch ${detBr}) — Code + Issues (${res.openIssuesCount || 0}) + PRs (${res.openPrsCount || 0}) + Actions (${res.actionsRunsCount || 0}) + 🚀 Auto-PR Direto ATIVO${wfNote}!`;
          } else {
            stBox.style.background = 'rgba(245,158,11,0.14)';
            stBox.style.border = '1px solid rgba(245,158,11,0.45)';
            stBox.style.color = '#fcd34d';
            stBox.textContent = `🌐 ${res.fullName} (branch ${detBr}) — Leitura de Code/Issues/PRs/Actions OK! Para os Agents criarem PRs sozinhos sem você no loop, clique em "🔑 Gerar Token" acima e cole seu PAT!`;
          }
          showToast(`Acesso verificado em ${res.fullName}!`, 'success');
        } else {
          stBox.style.background = 'rgba(239,68,68,0.14)';
          stBox.style.border = '1px solid rgba(239,68,68,0.45)';
          stBox.style.color = '#fca5a5';
          stBox.textContent = `❌ ${(res && res.error) || 'Falha ao acessar link.'}`;
          showToast((res && res.error) || 'Falha ao acessar link do GitHub.', 'error');
        }
      };

      body.querySelector('#ghd-connect-btn').onclick = async () => {
        await persistQuickGh();
        const repo = repoInp.value.trim();
        if (!repo) {
          showToast('Cole o link completo do repositório GitHub (https://github.com/...)!', 'error');
          return;
        }
        const btn = body.querySelector('#ghd-connect-btn');
        btn.disabled = true;
        btn.textContent = 'Conectando no Agent...';
        const res = await sendBgMessage({
          type: 'AU_SEND_GITHUB_TO_TAB',
          repo,
          token: tokInp.value.trim(),
          baseBranch: branchInp.value.trim() || 'main',
          authMode: authSel.value,
          autoCreatePR: autoPrChk.checked,
          userPrompt: body.querySelector('#ghd-task').value.trim(),
          enableLoop: true
        });
        btn.disabled = false;
        btn.textContent = '🚀 Conectar Repositório & Ativar Auto-PR nesta Aba';
        if (res && res.ok) {
          runtime.drawerOpen = false;
          renderDrawer();
          showToast(`🐙 Repositório ${res.repo} enviado para o Agent clonar em /home/user/repo!`, 'success');
        } else {
          showToast((res && res.error) || 'Falha ao conectar repositório.', 'error');
        }
      };

      const pushWsBtn = body.querySelector('#ghd-push-ws-btn');
      if (pushWsBtn && isSavedAgent) {
        pushWsBtn.onclick = async () => {
          await persistQuickGh();
          const repo = repoInp.value.trim();
          const token = tokInp.value.trim();
          if (!repo || !token) {
            showToast('Informe o Link do Repositório e seu Token PAT acima para fazer Commit & Push!', 'error');
            return;
          }
          pushWsBtn.disabled = true;
          pushWsBtn.textContent = '🐙 Enviando Workspace...';
          const out = await sendBgMessage({
            type: 'AU_GITHUB_PUSH_BUNDLE',
            repo,
            token,
            baseBranch: branchInp.value.trim() || 'main',
            branch: branchInp.value.trim() || 'main',
            roomId: runtime.collabRoomId || '',
            openPR: Boolean(body.querySelector('#ghd-open-pr').checked),
            message:
              body.querySelector('#ghd-commit-msg').value.trim() ||
              `feat(arena-agent): push do workspace (${document.title || 'Arena Agent'})`
          });
          pushWsBtn.disabled = false;
          pushWsBtn.textContent = '⬆ Criar Commit & Pull Request Agora';
          if (out && out.ok) {
            const prSuffix = out.pullRequest && out.pullRequest.number ? ` • PR #${out.pullRequest.number} aberto!` : '';
            showToast(`✅ Commit ${out.shortSha} enviado (${out.filesCount} arquivos) em ${out.repo}@${out.branch}${prSuffix}`, 'success');
          } else {
            showToast((out && out.error) || 'Falha ao enviar Workspace ao GitHub.', 'error');
          }
        };
      }
      return;
    }

    if (tab === 'prompts') {
      body.innerHTML = `
        <div class="au-card">
          <div class="au-card-title"><span>Biblioteca de Prompts & Comandos "/"</span></div>
          <input id="pr-search" class="au-input" placeholder="Buscar por título, /comando ou categoria..." />
          <div id="pr-list" style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto;"></div>
        </div>

        <div class="au-card">
          <div class="au-card-title"><span>Criar Novo Template</span></div>
          <div class="au-row">
            <input id="pr-new-title" class="au-input" placeholder="Título do prompt" style="flex:1;" />
            <input id="pr-new-slash" class="au-input" placeholder="/atalho" style="width:105px;" />
          </div>
          <textarea id="pr-new-content" class="au-textarea" placeholder="Use {{variavel}} para criar campos dinâmicos..."></textarea>
          <button id="pr-save-btn" class="au-btn au-btn-primary">Salvar na Biblioteca</button>
        </div>
      `;

      const renderPromptsFiltered = (q) => {
        const listEl = body.querySelector('#pr-list');
        const filtered = promptsList.filter((p) => {
          if (!q) return true;
          const s = q.toLowerCase();
          return (p.title || '').toLowerCase().includes(s) || (p.slash || '').toLowerCase().includes(s) || (p.content || '').toLowerCase().includes(s);
        });
        listEl.innerHTML = filtered
          .map(
            (p) => `
            <div class="au-queue-item" style="flex-direction:column;gap:6px;">
              <div class="au-row" style="width:100%;justify-content:space-between;">
                <strong>${escapeHtml(p.title)}</strong>
                <span class="au-badge">${escapeHtml(p.slash || p.category || 'Geral')}</span>
              </div>
              <div class="au-muted">${escapeHtml(p.content.slice(0, 120))}${p.content.length > 120 ? '...' : ''}</div>
              <div class="au-row">
                <button class="au-btn pr-use" data-id="${escapeHtml(p.id)}" style="padding:5px 10px;">Inserir</button>
                <button class="au-btn au-btn-primary pr-send" data-id="${escapeHtml(p.id)}" style="padding:5px 10px;">Enviar</button>
              </div>
            </div>
          `
          )
          .join('');

        listEl.querySelectorAll('.pr-use').forEach((b) => {
          b.onclick = () => {
            const found = promptsList.find((x) => x.id === b.dataset.id);
            if (found) applyPromptTemplate(found, false);
          };
        });
        listEl.querySelectorAll('.pr-send').forEach((b) => {
          b.onclick = () => {
            const found = promptsList.find((x) => x.id === b.dataset.id);
            if (found) applyPromptTemplate(found, true);
          };
        });
      };

      body.querySelector('#pr-search').oninput = (e) => renderPromptsFiltered(e.target.value);
      body.querySelector('#pr-save-btn').onclick = async () => {
        const title = body.querySelector('#pr-new-title').value.trim();
        const slash = body.querySelector('#pr-new-slash').value.trim();
        const content = body.querySelector('#pr-new-content').value.trim();
        if (!title || !content) {
          showToast('Informe título e conteúdo do template.', 'error');
          return;
        }
        await AU_STORAGE.upsertPrompt({ title, slash, content, category: 'Personalizado' });
        promptsList = await AU_STORAGE.getPrompts();
        renderDrawerBody();
        showToast('Template salvo com sucesso!', 'success');
      };

      renderPromptsFiltered('');
      return;
    }

    if (tab === 'export') {
      body.innerHTML = `
        <div class="au-card">
          <div class="au-card-title"><span>Organizar & Salvar este Chat</span></div>
          <select id="ex-folder" class="au-select">
            <option value="">Sem pasta específica</option>
            ${foldersList.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('')}
          </select>
          <input id="ex-tags" class="au-input" placeholder="Tags separadas por vírgula (ex: agent, app, prod)" />
          <button id="ex-save-now" class="au-btn au-btn-primary">💾 Salvar Snapshot no Histórico</button>
        </div>

        <div class="au-card">
          <div class="au-card-title"><span>Exportar Conversa Atual</span></div>
          <div class="au-muted">Baixe todo o conteúdo desta sessão com formatação limpa.</div>
          <div class="au-row-wrap">
            <button id="ex-md" class="au-btn" style="flex:1;">⬇ Markdown (.md)</button>
            <button id="ex-html" class="au-btn" style="flex:1;">⬇ PDF / HTML</button>
            <button id="ex-json" class="au-btn" style="flex:1;">⬇ JSON</button>
          </div>
        </div>

        <div class="au-card">
          <div class="au-card-title"><span>Histórico Completo & Busca Global</span></div>
          <div class="au-muted">Pesquise no texto completo de todos os seus chats salvos na Central Arena Ultra.</div>
          <button id="ex-open-history" class="au-btn">Abrir Histórico & Estatísticas ↗</button>
        </div>
      `;

      body.querySelector('#ex-save-now').onclick = async () => {
        const folderId = body.querySelector('#ex-folder').value;
        const tags = body.querySelector('#ex-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
        const saved = await autoSaveCurrentConversationSnapshot(folderId, tags);
        if (saved) showToast('Conversa salva no histórico local!', 'success');
        else showToast('Nenhuma mensagem encontrada ainda nesta página.', 'error');
      };

      const buildCurrentChatObj = () => ({
        title: document.title.replace(/^⚠️ \[SEM TOKENS\]\s*/, '') || 'Sessão Arena.ai',
        sessionUrl: location.href,
        mode: detectCurrentArenaMode(),
        loopsCount: runtime.loopsCount,
        updatedAt: Date.now(),
        tags: ['arena-ultra'],
        messages: scrapeConversationMessages(true)
      });

      body.querySelector('#ex-md').onclick = () => {
        const chat = buildCurrentChatObj();
        triggerFileDownload('arena-conversa.md', AU_STORAGE.formatChatAsMarkdown(chat), 'text/markdown;charset=utf-8');
        showToast('Exportado em Markdown!', 'success');
      };
      body.querySelector('#ex-html').onclick = () => {
        const chat = buildCurrentChatObj();
        const html = AU_STORAGE.formatChatAsHtml(chat);
        const win = window.open('', '_blank');
        if (win) {
          win.document.write(html);
          win.document.close();
        } else {
          triggerFileDownload('arena-conversa.html', html, 'text/html;charset=utf-8');
        }
      };
      body.querySelector('#ex-json').onclick = () => {
        const chat = buildCurrentChatObj();
        triggerFileDownload('arena-conversa.json', JSON.stringify(chat, null, 2), 'application/json;charset=utf-8');
        showToast('Exportado em JSON!', 'success');
      };
      body.querySelector('#ex-open-history').onclick = () => {
        chrome.runtime.sendMessage({ type: 'AU_OPEN_DASHBOARD', section: 'history' });
      };
      return;
    }

    if (tab === 'visual') {
      const presets = Object.values(AU_DEFAULTS.PRESET_THEMES);
      body.innerHTML = `
        <div class="au-card">
          <div class="au-card-title"><span>Presets de Temas (1 Clique)</span></div>
          <div class="au-theme-grid">
            ${presets
              .map(
                (t) => `
              <div class="au-theme-card ${settings.activeTheme === t.id ? 'active' : ''}" data-theme="${escapeHtml(t.id)}">
                <div class="au-swatches">
                  ${t.swatches.map((c) => `<span class="au-swatch" style="background:${c}"></span>`).join('')}
                </div>
                <strong style="font-size:12px;">${escapeHtml(t.name)}</strong>
                <span class="au-muted" style="font-size:10.5px;">${escapeHtml(t.subtitle)}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>

        <div class="au-card">
          <div class="au-card-title"><span>Layout, Modo Zen & Alertas</span></div>
          <label class="au-row au-muted" style="cursor:pointer;">
            <input id="vis-zen" type="checkbox" ${settings.zenMode ? 'checked' : ''} />
            <span>Modo Zen (Ocultar barra lateral do Arena.ai)</span>
          </label>
          <label class="au-row au-muted" style="cursor:pointer;">
            <input id="vis-sound" type="checkbox" ${settings.soundEnabled ? 'checked' : ''} />
            <span>Alerta sonoro ao parar por falta de tokens</span>
          </label>

          <div>
            <div class="au-row" style="justify-content:space-between;">
              <span class="au-muted">Largura do Chat (Widescreen)</span>
              <span id="vis-width-val" class="au-badge">${settings.chatWidthPercent ? settings.chatWidthPercent + '%' : 'Padrão'}</span>
            </div>
            <input id="vis-width" type="range" min="60" max="100" step="5" value="${settings.chatWidthPercent || 60}" style="width:100%;margin-top:4px;" />
          </div>

          <div class="au-row">
            <span class="au-muted" style="flex:1;">Tipografia:</span>
            <select id="vis-font" class="au-select" style="width:170px;">
              <option value="native" ${settings.fontFamily === 'native' ? 'selected' : ''}>Nativa Arena</option>
              <option value="inter" ${settings.fontFamily === 'inter' ? 'selected' : ''}>Inter Clean</option>
              <option value="jetbrains" ${settings.fontFamily === 'jetbrains' ? 'selected' : ''}>JetBrains Mono</option>
              <option value="serif" ${settings.fontFamily === 'serif' ? 'selected' : ''}>Editorial Serif</option>
            </select>
          </div>
        </div>
      `;

      body.querySelectorAll('.au-theme-card').forEach((card) => {
        card.onclick = async () => {
          settings = await AU_STORAGE.saveSettings({ activeTheme: card.dataset.theme });
          AU_THEMES.applyArenaVisualSettings(settings);
          chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
          renderDrawerBody();
        };
      });

      body.querySelector('#vis-zen').onchange = async (e) => {
        settings = await AU_STORAGE.saveSettings({ zenMode: e.target.checked });
        AU_THEMES.applyArenaVisualSettings(settings);
      };
      body.querySelector('#vis-sound').onchange = async (e) => {
        settings = await AU_STORAGE.saveSettings({ soundEnabled: e.target.checked });
      };
      let widthSaveTimer = null;
      body.querySelector('#vis-width').oninput = (e) => {
        const raw = Number(e.target.value);
        const pct = raw <= 60 ? 0 : raw;
        body.querySelector('#vis-width-val').textContent = pct ? pct + '%' : 'Padrão';
        settings = Object.assign({}, settings, { chatWidthPercent: pct });
        AU_THEMES.applyArenaVisualSettings(settings);
        clearTimeout(widthSaveTimer);
        widthSaveTimer = setTimeout(async () => {
          settings = await AU_STORAGE.saveSettings({ chatWidthPercent: pct });
        }, 180);
      };
      body.querySelector('#vis-font').onchange = async (e) => {
        settings = await AU_STORAGE.saveSettings({ fontFamily: e.target.value });
        AU_THEMES.applyArenaVisualSettings(settings);
      };
    }
  }

  // --- Listen to Commands from Service Worker, Popup & Dashboard ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    // ARENA-11: Global 1-Click Emergency Kill Switch ("PARAR TUDO" < 2s)
    if (msg.type === 'AU_EMERGENCY_STOP_ALL') {
      let stoppedGenerating = false;
      const stopBtn = findStopButton();
      if (stopBtn && !stopBtn.disabled) {
        try {
          stopBtn.click();
          stoppedGenerating = true;
        } catch (_) {}
      }
      runtime.autoContinueEnabled = false;
      runtime.sendingInProgress = false;
      runtime.collabWaitingPeers = false;
      runtime.pendingReloadPrompt = '';
      runtime.promptQueue = [];
      runtime.status = 'paused';
      runtime.stopReason = '🛑 PARAR TUDO acionado pelo usuário';
      updateWebLock();
      saveToTabSessionStorage();
      syncTabStateToBackground();
      renderToolbarAndDrawerStatus();
      showToast('🛑 PARAR TUDO: todas as automações desta aba foram interrompidas.', 'error');
      sendResponse({ ok: true, stoppedGenerating });
      return;
    }

    if (msg.type === 'AU_ROOM_MESSAGE_NOTIFICATION') {
      if (String(msg.roomId) !== String(runtime.collabRoomId) ||
          Number(msg.bindingEpoch) !== Number(runtime.collabBindingEpoch || 1)) {
        sendResponse({ ok: false, ignored: true }); return;
      }
      const key = `${msg.roomId}:${msg.bindingEpoch}`;
      runtime.roomNotificationCursor = runtime.roomNotificationCursor || {};
      if (Number(msg.seq) > Number(runtime.roomNotificationCursor[key] || 0)) {
        runtime.roomNotificationCursor[key] = Number(msg.seq);
        const now = Date.now();
        if (now - Number(runtime.lastRoomNoticeAt || 0) > 5000) {
          runtime.lastRoomNoticeAt = now;
          showToast(`${msg.direct ? '🎯 Mensagem para você' : '🔔 Nova mensagem na sala'}: ${String(msg.senderName || 'Colega').slice(0, 100)}. Consulte /tmp/au_chat inbox.`, 'info');
        }
      }
      sendResponse({ ok: true }); return;
    }

    if (msg.type === 'AU_HEARTBEAT_TICK') {
      if (msg.wakeCollabPeers) {
        runtime.lastTickAt = 0;
      }
      evaluateAutoContinueTick();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'AU_CHECK_TAB_HAS_THINKING') {
      (async () => {
        const hit = detectThinkingModelIndicator();
        let archived = false;
        if (hit && msg.stopOnDetect) {
          const stopBtn = findStopButton();
          if (stopBtn && !stopBtn.disabled) {
            try { stopBtn.click(); } catch (_) {}
          }
          runtime.autoContinueEnabled = false;
          runtime.status = 'token_stopped';
          runtime.stopReason = `Modelo "${hit}" recusado da equipe`;
          updateWebLock();
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
          showToast(`🚫 Aba com "${hit}" recusada e arquivada — apenas modelos sem Thinking entram no Time!`, 'error');
          await bgSafeSleep(250);
          const archInfo = await archiveRefusedChatNow();
          archived = archInfo.archived;
        }
        sendResponse({
          ok: true,
          hasThinking: Boolean(hit),
          indicator: hit || '',
          archived,
          hasCleanAssistantReply: !hit && Boolean(getLastAssistantText().trim()),
          isGenerating: Boolean(findStopButton())
        });
      })();
      return true;
    }

    if (msg.type === 'AU_RUN_PENDING_JOB') {
      if (msg.job) {
        executePendingLaunchJob(msg.job);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'AU_EXECUTE_TAB_COMMAND') {
      const cmd = msg.command;
      const p = msg.payload || {};
      (async () => {
        // ARENA-18: Enforce roomId + bindingEpoch on room-scoped commands so rebound/stale tabs never execute cross-room turns!
        if (p.expectedRoomId) {
          if (String(p.expectedRoomId) !== String(runtime.collabRoomId || '')) {
            sendResponse({ ok: false, reason: 'room_binding_mismatch' });
            return;
          }
          if (p.bindingEpoch !== undefined && Number(p.bindingEpoch) !== Number(runtime.collabBindingEpoch || 0)) {
            sendResponse({ ok: false, reason: 'stale_binding_epoch' });
            return;
          }
        }

        if (cmd === 'toggle_auto_continue') {
          const desired =
            p.enable !== undefined ? p.enable : p.enabled !== undefined ? p.enabled : !runtime.autoContinueEnabled;
          toggleAutoContinue(Boolean(desired));
        } else if (cmd === 'emergency_stop') {
          runtime.autoContinueEnabled = false;
          runtime.collabWaitingPeers = false;
          runtime.status = 'idle';
          runtime.stopReason = p.reason || 'PARAR TUDO acionado';
          const stopBtn = findStopButton();
          if (stopBtn && !stopBtn.disabled) {
            try {
              stopBtn.click();
            } catch (_) {}
          }
          updateWebLock();
          saveToTabSessionStorage();
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
          showToast('🛑 PARAR TUDO acionado: geração e Autopilot pausados imediatamente.', 'warning');
        } else if (cmd === 'pause_all' || cmd === 'pause') {
          if (runtime.autoContinueEnabled) toggleAutoContinue(false);
        } else if (cmd === 'resume_all' || cmd === 'resume') {
          if (!runtime.autoContinueEnabled && runtime.status !== 'token_stopped') toggleAutoContinue(true);
        } else if (cmd === 'attach_files') {
          const attRes = await sendBridgeCommand('attach_files', '', 7000, { attachments: p.attachments || [] });
          sendResponse(attRes);
          return;
        } else if (cmd === 'send_custom_prompt') {
          if (p.repo) {
            runtime.githubActive = true;
            runtime.githubRepo = String(p.repo || '');
            if (p.baseBranch) runtime.githubBaseBranch = String(p.baseBranch);
            if (p.branch) runtime.githubBranch = String(p.branch);
          }
          if (p.hasVaultToken !== undefined) {
            runtime.hasVaultToken = Boolean(p.hasVaultToken);
          }
          if (p.enableLoop !== false && !runtime.autoContinueEnabled && runtime.status !== 'token_stopped') {
            runtime.autoContinueEnabled = true;
            runtime.justEnabledReadyToFire = false;
            updateWebLock();
          }
          let sentOk = false;
          if (p.prompt) {
            for (let w = 0; w < 10 && !findChatInput() && !findTaskReviewPanel(); w++) {
              await bgSafeSleep(350);
            }
            const resSend = await injectAndSubmitPrompt(p.prompt, 'github_connect', {
              attachments: p.attachments
            });
            sentOk = Boolean(resSend);
          }
          syncTabStateToBackground();
          saveToTabSessionStorage();
          renderToolbarAndDrawerStatus();
          sendResponse({ ok: sentOk });
          return;
        } else if (cmd === 'join_collab_room') {
          runtime.collabRoomId = String(p.roomId || '');
          runtime.collabBindingEpoch = Number(p.bindingEpoch || 1);
          runtime.collabAgentName = p.agentName || '';
          runtime.collabWaitingPeers = false;
          runtime.selectedDrawerRoomId = runtime.collabRoomId;
          if (p.refuseThinkingModels !== undefined) {
            runtime.jobRefuseThinking = Boolean(p.refuseThinkingModels);
          }
          if (p.githubActive) {
            runtime.githubActive = true;
            if (p.githubRepo) runtime.githubRepo = String(p.githubRepo);
            if (p.githubBaseBranch) runtime.githubBaseBranch = String(p.githubBaseBranch);
            if (p.githubBranch) runtime.githubBranch = String(p.githubBranch);
          }
          runtime.admittedToTeam = p.admittedToTeam !== false;
          if (!runtime.autoContinueEnabled && runtime.status !== 'token_stopped') {
            toggleAutoContinue(true);
          } else {
            syncTabStateToBackground();
            saveToTabSessionStorage();
            renderToolbarAndDrawerStatus();
          }
          showToast(`🤝 Conectado à Sala TempChat #${runtime.collabRoomId} (${runtime.collabAgentName || 'Agente'})!`, 'success');
          if (p.kickoffPrompt) {
            if (!findStopButton()) {
              bgSafeSleep(350).then(() => {
                if (!findStopButton() && !runtime.sendingInProgress) {
                  injectAndSubmitPrompt(p.kickoffPrompt, 'collab_unite_kickoff');
                } else if (!runtime.promptQueue.includes(p.kickoffPrompt)) {
                  runtime.promptQueue.unshift(p.kickoffPrompt);
                  syncTabStateToBackground();
                }
              });
            } else if (!runtime.promptQueue.includes(p.kickoffPrompt)) {
              runtime.promptQueue.unshift(p.kickoffPrompt);
              syncTabStateToBackground();
            }
          }
        } else if (cmd === 'leave_collab_room') {
          runtime.collabRoomId = '';
          runtime.collabBindingEpoch = 0;
          runtime.collabAgentName = '';
          runtime.collabWaitingPeers = false;
          saveToTabSessionStorage();
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
        } else if (cmd === 'collab_room_completed') {
          runtime.autoContinueEnabled = false;
          runtime.collabWaitingPeers = false;
          runtime.status = 'idle';
          runtime.stopReason = `Consenso atingido na Sala TempChat #${p.roomId || runtime.collabRoomId}`;
          updateWebLock();
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
          showToast(`✅ Entrega Final pronta na Sala #${p.roomId || runtime.collabRoomId} (por ${p.finalBy || 'Equipe'})!`, 'success');
        } else if (cmd === 'broadcast_prompt' || cmd === 'send_prompt') {
          if (p.prompt) {
            await injectAndSubmitPrompt(p.prompt, 'broadcast', {
              attachments: p.attachments
            });
          }
        } else if (cmd === 'open_drawer') {
          runtime.drawerOpen = true;
          if (p.tab) runtime.activeDrawerTab = p.tab;
          if (p.roomId) runtime.selectedDrawerRoomId = p.roomId;
          renderDrawer();
        } else if (cmd === 'export_workspace_files') {
          const wsRes = await exportCurrentTabWorkspacePayload(p.preferRepoSubdir !== false);
          sendResponse(wsRes);
          return;
        } else if (cmd === 'download_workspace') {
          const dlRes = await downloadCurrentTabWorkspaceAsZip(p);
          sendResponse(dlRes);
          return;
        } else if (cmd === 'apply_settings') {
          settings = await AU_STORAGE.getSettings();
          promptsList = await AU_STORAGE.getPrompts();
          macrosList = await AU_STORAGE.getMacros();
          foldersList = await AU_STORAGE.getFolders();
          if (p.hasVaultToken !== undefined) runtime.hasVaultToken = Boolean(p.hasVaultToken);
          AU_THEMES.applyArenaVisualSettings(settings);
          syncCleanChatVisibilityAttr();
          applyCleanChatAutoPromptFilter();
          ensurePromptToolbarMounted();
          renderToolbarAndDrawerStatus();
        }
        sendResponse({ ok: true });
      })();
      return true;
    }
  });

  // React ONLY to user-facing configuration changes (ignores high-frequency au_persisted_tab_states, au_metrics & au_saved_chats writes!)
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      if (!changes) return;
      const keys = AU_STORAGE.KEYS || {};
      const sKey = keys.SETTINGS || 'au_settings';
      const pKey = keys.PROMPTS || 'au_prompts';
      const mKey = keys.MACROS || 'au_macros';
      const fKey = keys.FOLDERS || 'au_folders';

      const changedSettings = Boolean(changes[sKey]);
      const changedPrompts = Boolean(changes[pKey]);
      const changedMacros = Boolean(changes[mKey]);
      const changedFolders = Boolean(changes[fKey]);

      if (!changedSettings && !changedPrompts && !changedMacros && !changedFolders) {
        return;
      }

      if (changedSettings) settings = await AU_STORAGE.getSettings();
      if (changedPrompts) promptsList = (changes[pKey].newValue) || (await AU_STORAGE.getPrompts());
      if (changedMacros) macrosList = (changes[mKey].newValue) || (await AU_STORAGE.getMacros());
      if (changedFolders) foldersList = (changes[fKey].newValue) || (await AU_STORAGE.getFolders());

      if (changedSettings) {
        AU_THEMES.applyArenaVisualSettings(settings);
        ensurePromptToolbarMounted(true);
        renderToolbarAndDrawerStatus();
      }
      if (runtime.drawerOpen && (changedPrompts || changedMacros || changedFolders)) {
        renderDrawerBody();
      }
    });
  }

  // --- Handle Pending Multi-Agent Launch Job on Tab Boot ---
  const completedJobIds = new Set();
  let activeJobRunning = false;

  async function executePendingLaunchJob(job) {
    if (!isCurrentInstance()) return;
    if (!job || !job.initialPrompt) return;
    const jobId = job.jobId || job.initialPrompt.slice(0, 60);
    if (completedJobIds.has(jobId) || activeJobRunning) return;

    completedJobIds.add(jobId);
    runtime.pendingLaunchJobId = jobId;
    runtime.lastAttemptedPrompt = job.initialPrompt;
    runtime.initialSessionPrompt = job.initialPrompt;
    runtime.harnessInitialized = String(job.initialPrompt).includes('HARNESS ARENA ULTRA');
    runtime.sawActivitySinceLastSend = false;
    runtime.justEnabledReadyToFire = false;
    runtime.stopReason = '';
    if (job.refuseThinkingModels !== undefined) {
      runtime.jobRefuseThinking = Boolean(job.refuseThinkingModels);
    }
    runtime.rerollAttempt = Number(job.rerollAttempt || 0);
    runtime.admittedToTeam = job.collabRoomId ? !isRefuseThinkingActive() : true;
    activeJobRunning = true;

    try {
      runtime.strategy = job.strategy || settings.autoContinueStrategy || 'hybrid';
      if (job.fixedPrompt) runtime.customFixedPrompt = job.fixedPrompt;
      if (Array.isArray(job.queue) && job.queue.length && runtime.promptQueue.length === 0) {
        runtime.promptQueue = job.queue.slice();
      }
      if (job.collabRoomId) {
        runtime.collabRoomId = String(job.collabRoomId);
        runtime.collabBindingEpoch = Number(job.bindingEpoch || 1);
        runtime.selectedDrawerRoomId = runtime.collabRoomId;
      }
      if (job.collabAgentName) {
        runtime.collabAgentName = job.collabAgentName;
      }
      if (job.githubActive) {
        runtime.githubActive = true;
        if (job.githubRepo) runtime.githubRepo = job.githubRepo;
        if (job.githubBaseBranch) runtime.githubBaseBranch = job.githubBaseBranch;
        if (job.githubBranch) runtime.githubBranch = job.githubBranch;
      }
      if (job.hasVaultToken !== undefined) {
        runtime.hasVaultToken = Boolean(job.hasVaultToken);
      }

      await ensurePageBridgeReady(5000);
      let launchTransientErrors = 0;

      for (let attempt = 0; attempt < 60; attempt++) {
        if (!isCurrentInstance()) return;
        if (runtime.status === 'token_stopped' || runtime.refusingInProgress) {
          runtime.pendingLaunchJobId = null;
          return;
        }

        if (detectSecurityVerificationOnPage()) {
          if (job.autoEnableLoop) {
            runtime.autoContinueEnabled = true;
            updateWebLock();
          }
          await enterCaptchaWaitingState(job.initialPrompt, 'multi_agent_init');
          syncTabStateToBackground();
          renderToolbarAndDrawerStatus();
          return;
        }

        const inp = findChatInput();
        if (inp) {
          await bgSafeSleep(1100);
          if (runtime.status === 'token_stopped' || runtime.refusingInProgress) {
            runtime.pendingLaunchJobId = null;
            return;
          }
          if (job.autoEnableLoop) {
            runtime.autoContinueEnabled = true;
            updateWebLock();
          }
          const sent = await injectAndSubmitPrompt(job.initialPrompt, 'multi_agent_init', {
            attachments: job.attachments
          });
          if (runtime.status === 'token_stopped' || runtime.refusingInProgress) {
            runtime.pendingLaunchJobId = null;
            try {
              chrome.runtime.sendMessage({ type: 'AU_CONFIRM_JOB_STARTED', jobId });
            } catch (_) {}
            syncTabStateToBackground();
            renderToolbarAndDrawerStatus();
            return;
          }
          if (sent === 'captcha_waiting') {
            syncTabStateToBackground();
            renderToolbarAndDrawerStatus();
            return;
          }
          if (sent === 'transient_error') {
            launchTransientErrors += 1;
            if (launchTransientErrors >= 3 && /^\/agent\/[A-Za-z0-9_-]{3,}/i.test(location.pathname || '')) {
              showToast('🔄 Sessão inicial travada no Arena — arquivando e abrindo nova sessão limpa...', 'info');
              const archInfo = await archiveRefusedChatNow();
              await sendBgMessage({
                type: 'AU_RECOVER_DEAD_SESSION',
                payload: {
                  archived: archInfo.archived,
                  convId: archInfo.convId || '',
                  collabRoomId: runtime.collabRoomId || '',
                  bindingEpoch: runtime.collabBindingEpoch || 0,
                  collabAgentName: runtime.collabAgentName || '',
                  githubActive: Boolean(runtime.githubActive),
                  githubRepo: runtime.githubRepo || '',
                  githubBaseBranch: runtime.githubBaseBranch || '',
                  githubBranch: runtime.githubBranch || '',
                  refuseThinkingModels: isRefuseThinkingActive(),
                  initialPrompt: job.initialPrompt,
                  autoContinueEnabled: Boolean(job.autoEnableLoop),
                  strategy: runtime.strategy,
                  fixedPrompt: runtime.customFixedPrompt,
                  queue: runtime.promptQueue
                }
              });
              return;
            }
            showToast('🔄 Arena falhou ao criar a sessão inicial — tentando novamente em 2.5s...', 'info');
            await bgSafeSleep(2500);
            continue;
          }
          if (sent === true) {
            runtime.pendingLaunchJobId = null;
            try {
              chrome.runtime.sendMessage({ type: 'AU_CONFIRM_JOB_STARTED', jobId });
            } catch (_) {}
            syncTabStateToBackground();
            renderToolbarAndDrawerStatus();
            return;
          }
        }
        await bgSafeSleep(650);
      }

      completedJobIds.delete(jobId);
    } finally {
      activeJobRunning = false;
    }
  }

  // --- Bootstrap Everything ---
  async function bootstrap() {
    settings = await AU_STORAGE.getSettings();
    promptsList = await AU_STORAGE.getPrompts();
    macrosList = await AU_STORAGE.getMacros();
    foldersList = await AU_STORAGE.getFolders();
    runtime.strategy = settings.autoContinueStrategy || 'hybrid';
    runtime.boundConvKey = extractConvKeyFromHref(location.href);

    // 1. Synchronous restore of solo autopilot state from tab sessionStorage (NEVER restores room binding on its own — ARENA-18!)
    restoreFromTabSessionStorage();

    // 2. Register with authoritative Background Service Worker BEFORE opening keep-alive port
    const readyRes = await new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        resolve(val || null);
      };
      const timer = setTimeout(() => done(null), 1800);
      try {
        chrome.runtime.sendMessage(
          {
            type: 'AU_CONTENT_READY',
            initialState: {
              url: location.href,
              title: document.title || 'Arena.ai',
              mode: detectCurrentArenaMode()
            }
          },
          (res) => {
            clearTimeout(timer);
            void chrome.runtime.lastError;
            done(res);
          }
        );
      } catch (_) {
        clearTimeout(timer);
        done(null);
      }
    });

    if (readyRes && readyRes.ok) {
      runtime.tabId = readyRes.tabId;
      runtime.hasVaultToken = Boolean(readyRes.hasVaultToken);
      if (readyRes.restoredState && !readyRes.pendingJob) {
        applyRestoredAutopilotSnapshot(readyRes.restoredState, true);
      }
      // ARENA-18: If SW explicitly reports no room binding, purge any stale room hint in sessionStorage
      if (!readyRes.pendingJob && (!readyRes.restoredState || !readyRes.restoredState.collabRoomId)) {
        runtime.collabRoomId = '';
        runtime.collabBindingEpoch = 0;
        saveToTabSessionStorage();
      }
    }

    AU_THEMES.applyArenaVisualSettings(settings);
    ensureCleanChatStylesInjected();
    applyCleanChatAutoPromptFilter();
    injectPageBridge();
    mountRootShadowUI();
    ensurePromptToolbarMounted();
    renderToolbarAndDrawerStatus();
    setupBattleVoteObserver();

    // 3. Only now connect keep-alive port and sync full restored state!
    connectKeepAlivePort();

    if (readyRes && readyRes.pendingJob) {
      executePendingLaunchJob(readyRes.pendingJob);
    }

    // Post-navigation straggler cleanup: if any refused/dead session navigated before archive finished, archive it via same-origin API now!
    if (readyRes && Array.isArray(readyRes.pendingArchiveIds) && readyRes.pendingArchiveIds.length > 0) {
      const idsToClean = readyRes.pendingArchiveIds.slice(0, 12);
      ensurePageBridgeReady(3500)
        .then(() => sendBridgeCommand('archive_conv_ids', idsToClean.join(','), 9000))
        .then((res) => {
          if (res && Array.isArray(res.archivedIds) && res.archivedIds.length > 0) {
            sendBgMessage({ type: 'AU_CONFIRM_ARCHIVED_IDS', ids: res.archivedIds });
          }
        })
        .catch(() => {});
    }

    // Lightweight structural DOM observer (no characterData token storm!) for SPA route / composer swaps + hiding automatic prompts
    let toolbarRemountTimer = null;
    let cleanChatFilterTimer = null;
    const observer = new MutationObserver(() => {
      if (!isCurrentInstance()) {
        observer.disconnect();
        return;
      }
      if (!cleanChatFilterTimer) {
        cleanChatFilterTimer = setTimeout(() => {
          cleanChatFilterTimer = null;
          applyCleanChatAutoPromptFilter();
        }, 160);
      }
      if (toolbarRemountTimer) return;
      if (!toolbarHost || !toolbarHost.isConnected || !toolbarHost.nextElementSibling || !toolbarHost.nextElementSibling.isConnected) {
        toolbarRemountTimer = setTimeout(() => {
          toolbarRemountTimer = null;
          ensurePromptToolbarMounted(true);
        }, 250);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Local tick fallback (skips duplicate work when Service Worker heartbeat is actively ticking!)
    const localTickId = setInterval(() => {
      if (!isCurrentInstance()) {
        clearInterval(localTickId);
        return;
      }
      if (!toolbarHost || !toolbarHost.isConnected) {
        ensurePromptToolbarMounted();
      }
      if (Date.now() - runtime.lastSwHeartbeatAt >= 4200) {
        evaluateAutoContinueTick();
      }
    }, 1800);

    // Instant wake recovery when returning from Memory Saver, Windows Lock Screen, Sleep/Hibernate, or tab switch
    const onWakeUp = () => {
      if (!isCurrentInstance()) return;
      if (!runtime.keepAlivePort) connectKeepAlivePort();
      syncTabStateToBackground();
      ensurePromptToolbarMounted();
      evaluateAutoContinueTick();
    };
    document.addEventListener('visibilitychange', onWakeUp);
    document.addEventListener('resume', onWakeUp);
    window.addEventListener('focus', onWakeUp);
    window.addEventListener('pageshow', onWakeUp);
  }

  bootstrap();
})();
