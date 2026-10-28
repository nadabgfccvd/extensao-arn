(function () {
  'use strict';
  const BRIDGE_VERSION = '4.0.0';
  const ALLOWED_ARENA_ORIGINS = new Set([
    'https://arena.ai',
    'https://www.arena.ai',
    'https://lmarena.ai',
    'https://web.lmarena.ai'
  ]);
  if (typeof location === 'object' && location.origin && !ALLOWED_ARENA_ORIGINS.has(location.origin)) {
    return;
  }

  if (window.__AU_PAGE_BRIDGE_VERSION__ === BRIDGE_VERSION) {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-au-bridge-ready', '1');
      document.documentElement.setAttribute('data-au-bridge-version', BRIDGE_VERSION);
    }
    return;
  }
  window.__AU_PAGE_BRIDGE_VERSION__ = BRIDGE_VERSION;
  window.__AU_PAGE_BRIDGE_ACTIVE__ = true;

  // SEC-07: Per-document CSPRNG nonce + 2-way handshake token with ISOLATED content.js
  function generateBridgeNonce() {
    try {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b)
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    } catch (_) {
      return 'bn_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }
  const mainBridgeNonce = generateBridgeNonce();
  let bridgeSessionToken = '';
  const pendingOutboundQueue = [];

  const bridgeState = (window.__AU_BRIDGE_STATE__ = window.__AU_BRIDGE_STATE__ || {
    activeStreams: 0,
    lastChunkAt: 0,
    chatPostCounter: 0,
    inCommand: 0,
    lastCreatedConvId: '',
    inFlightArchiveFetches: 0,
    lastTransientErrorAt: 0,
    lastTransientErrorReason: '',
    rejectedUntrustedMessages: 0
  });
  bridgeState.activeStreams = 0;
  bridgeState.inCommand = 0;
  bridgeState.inFlightArchiveFetches = 0;
  bridgeState.rejectedUntrustedMessages = bridgeState.rejectedUntrustedMessages || 0;

  function markBridgeReady() {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-au-bridge-ready', '1');
      document.documentElement.setAttribute('data-au-bridge-version', BRIDGE_VERSION);
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        if (document.documentElement) {
          document.documentElement.setAttribute('data-au-bridge-ready', '1');
          document.documentElement.setAttribute('data-au-bridge-version', BRIDGE_VERSION);
        }
      }, { once: true });
    }
  }

  // SEC-07: Cross-World Structured-Clone IPC via window.postMessage locked to location.origin & sessionToken
  function postToContentScript(event, detail, isHandshakeAck = false) {
    try {
      const targetOrigin = (location && location.origin && location.origin !== 'null') ? location.origin : 'https://arena.ai';
      if (!isHandshakeAck && !bridgeSessionToken) {
        if (pendingOutboundQueue.length < 30) {
          pendingOutboundQueue.push({ event, detail: detail || {} });
        }
        return;
      }
      window.postMessage(
        {
          __au_ipc_v2__: true,
          dir: 'main->iso',
          token: bridgeSessionToken,
          event,
          detail: detail || {}
        },
        targetOrigin
      );
    } catch (_) {}
  }

  function flushOutboundQueue() {
    if (!bridgeSessionToken || !pendingOutboundQueue.length) return;
    while (pendingOutboundQueue.length > 0) {
      const item = pendingOutboundQueue.shift();
      postToContentScript(item.event, item.detail);
    }
  }

  function emitTelemetry(detail) {
    postToContentScript('au-network-telemetry', detail);
  }

  function emitCommandResult(detail) {
    postToContentScript('au-bridge-result', detail);
  }

  // ARENA-03: SPA Navigation Hooks (history.pushState / replaceState / popstate)
  if (!window.__AU_HISTORY_HOOKED_V4__ && typeof window.history === 'object' && window.history) {
    window.__AU_HISTORY_HOOKED_V4__ = true;
    let lastKnownRouteKey = (location.pathname || '') + (location.search || '');

    const notifyRouteChangeIfNeeded = (trigger) => {
      try {
        const nextKey = (location.pathname || '') + (location.search || '');
        if (nextKey === lastKnownRouteKey) return;
        const prevKey = lastKnownRouteKey;
        lastKnownRouteKey = nextKey;
        const m = (location.pathname || '').match(/\/(?:agent|c|chat|s|t)\/([A-Za-z0-9_-]{3,})/i);
        const urlConvId = (m && m[1]) || '';
        if (!urlConvId) {
          bridgeState.lastCreatedConvId = '';
        } else if (bridgeState.lastCreatedConvId && bridgeState.lastCreatedConvId !== urlConvId) {
          bridgeState.lastCreatedConvId = urlConvId;
        }
        emitTelemetry({
          type: 'route_change',
          trigger,
          prevRoute: prevKey,
          nextRoute: nextKey,
          pathname: location.pathname || '',
          convId: urlConvId,
          timestamp: Date.now()
        });
      } catch (_) {}
    };

    ['pushState', 'replaceState'].forEach((methodName) => {
      const orig = window.history[methodName];
      if (typeof orig === 'function') {
        window.history[methodName] = function (...args) {
          const ret = orig.apply(this, args);
          notifyRouteChangeIfNeeded(methodName);
          return ret;
        };
      }
    });
    window.addEventListener('popstate', () => notifyRouteChangeIfNeeded('popstate'));
  }

  // Dual-path sleep: races native setTimeout(waitMs) AND Service Worker AU_BG_SLEEP(waitMs).
  // Native setTimeout can NEVER fire early: when foreground/unthrottled it resolves in exact waitMs;
  // when backgrounded/Virtual-Desktop-occluded/Lock-Screen it is delayed while AU_BG_SLEEP resolves in exact waitMs!
  let bgSleepSeq = 0;
  const pendingBgSleeps = new Map();

  function sleep(ms) {
    const waitMs = Math.max(15, Number(ms) || 50);
    return new Promise((resolve) => {
      const id = 'bgs_' + (++bgSleepSeq) + '_' + Date.now();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        pendingBgSleeps.delete(id);
        resolve();
      };
      // 1. Native timer (wins immediately when foreground/unthrottled, zero IPC dependency!)
      setTimeout(finish, waitMs);
      // 2. Service Worker timer via content.js (wins when tab is backgrounded, occluded on Virtual Desktop 2, or on Lock Screen!)
      if (waitMs >= 40) {
        pendingBgSleeps.set(id, finish);
        postToContentScript('au-bg-sleep-req', { id, ms: waitMs });
      }
    });
  }

  // Command-Scoped Stalled-rAF Sweeper (Virtual Desktop 2 / Occluded Windows / Hidden Tabs):
  // CRITICAL PERFORMANCE RULE: NEVER wrap or flush rAF when `bridgeState.inCommand === 0`!
  // Otherwise Framer Motion / shimmer infinite rAF loops in hidden Agent tabs trigger 9 Hz cross-process IPCs forever!
  if (typeof window.requestAnimationFrame === 'function' && !window.__AU_RAF_SWEEPER_V4__) {
    window.__AU_RAF_SWEEPER_V4__ = true;
    const origRAF = window.requestAnimationFrame.bind(window);
    const origCAF = typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame.bind(window) : null;
    const pendingFrames = new Map();
    let sweepActive = false;

    function flushStalledNow() {
      if (pendingFrames.size === 0) return;
      const now = Date.now();
      for (const [id, entry] of Array.from(pendingFrames.entries())) {
        if (now - entry.queuedAt >= 110) {
          pendingFrames.delete(id);
          entry.run();
        }
      }
    }

    async function runOnDemandSweep() {
      if (sweepActive) return;
      sweepActive = true;
      try {
        while (bridgeState.inCommand > 0 && pendingFrames.size > 0) {
          await sleep(110);
          flushStalledNow();
        }
        // Clear any leftover frame callbacks once the bridge command finishes so nothing leaks
        if (bridgeState.inCommand <= 0 && pendingFrames.size > 0) {
          pendingFrames.clear();
        }
      } finally {
        sweepActive = false;
      }
    }

    window.requestAnimationFrame = function (cb) {
      if (typeof cb !== 'function' || bridgeState.inCommand <= 0) {
        return origRAF(cb);
      }
      let invoked = false;
      const queuedAt = Date.now();
      const rafId = origRAF((ts) => {
        pendingFrames.delete(rafId);
        if (invoked) return;
        invoked = true;
        cb(ts);
      });
      pendingFrames.set(rafId, {
        queuedAt,
        run: () => {
          if (invoked) return;
          invoked = true;
          try {
            if (origCAF) origCAF(rafId);
          } catch (_) {}
          try {
            cb(typeof performance !== 'undefined' ? performance.now() : Date.now());
          } catch (_) {}
        }
      });
      if (!sweepActive) {
        runOnDemandSweep();
      }
      return rafId;
    };

    if (origCAF) {
      window.cancelAnimationFrame = function (id) {
        if (pendingFrames.size > 0) pendingFrames.delete(id);
        return origCAF(id);
      };
    }
  }

  function isElementDisplayed(el) {
    if (!el || !el.isConnected) return false;
    if (typeof window.getComputedStyle !== 'function') return true;
    let cur = el;
    for (let d = 0; d < 8 && cur && cur.nodeType === 1; d++) {
      const st = window.getComputedStyle(cur);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      cur = cur.parentElement;
    }
    return true;
  }

  // --- Find Tiptap / ProseMirror / Textarea Composer in MAIN World ---
  function findComposerEditorElement() {
    if (!document.querySelectorAll) return null;
    const selectors = [
      '.editor-content .tiptap[contenteditable="true"]',
      '.editor-content .ProseMirror[contenteditable="true"]',
      '.tiptap.ProseMirror[contenteditable="true"]',
      '.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][translate="no"]',
      'main textarea:not([readonly])',
      'form textarea:not([readonly])',
      'textarea:not([readonly])'
    ];
    for (const sel of selectors) {
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
    return null;
  }

  function findTiptapEditorFromFiber(startEl) {
    let node = startEl;
    for (let depth = 0; depth < 6 && node; depth++) {
      if (node.editor && typeof node.editor.commands === 'object') {
        return node.editor;
      }
      const keys = Object.keys(node);
      const fiberKey = keys.find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (fiberKey) {
        let fiber = node[fiberKey];
        for (let step = 0; step < 22 && fiber; step++) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          if (props && props.editor && props.editor.view && props.editor.state) {
            return props.editor;
          }
          fiber = fiber.return;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function findProseMirrorView(el) {
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      if (cur.pmViewDesc && cur.pmViewDesc.view) {
        return cur.pmViewDesc.view;
      }
      cur = cur.parentElement;
    }
    const pmChild = el && el.querySelector ? el.querySelector('.ProseMirror') : null;
    if (pmChild && pmChild.pmViewDesc && pmChild.pmViewDesc.view) {
      return pmChild.pmViewDesc.view;
    }
    return null;
  }

  function findComposerOnSubmitFromFiber(startEl) {
    let node = startEl;
    for (let depth = 0; depth < 8 && node; depth++) {
      const keys = Object.keys(node);
      const fiberKey = keys.find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (fiberKey) {
        let fiber = node[fiberKey];
        for (let step = 0; step < 26 && fiber; step++) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          if (props && typeof props.onSubmit === 'function') {
            return props.onSubmit;
          }
          fiber = fiber.return;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function triggerFiberOnClickIfPresent(el) {
    let cur = el;
    for (let d = 0; d < 4 && cur; d++) {
      const keys = Object.keys(cur);
      const propsKey = keys.find((k) => k.startsWith('__reactProps$'));
      if (propsKey && cur[propsKey] && typeof cur[propsKey].onClick === 'function') {
        try {
          cur[propsKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: cur, currentTarget: cur });
          return true;
        } catch (_) {}
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function findTaskReviewPanelInMainWorld() {
    if (!document.querySelectorAll) return null;

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

    const scopeRoot = (document.querySelector && document.querySelector('main')) || document;
    let keepWorkingTarget = null;
    let closeBtnTarget = null;

    // Fast pass on real buttons first; only scan generic hoverable wrappers if buttons didn't match!
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
          (el.closest && (el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host'))) ||
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
          closeBtnTarget = el;
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
              keepWorkingTarget =
                (el.closest && el.closest('button, [role="button"]')) ||
                (el.querySelector && el.querySelector('button, [role="button"]')) ||
                el;
              break;
            }
            card = card.parentElement;
          }
          if (keepWorkingTarget) break;
        }
      }
      if (keepWorkingTarget) break;
    }

    if (!keepWorkingTarget && closeBtnTarget) {
      let card = closeBtnTarget.parentElement;
      for (let up = 0; up < 5 && card; up++) {
        const opts = Array.from(card.querySelectorAll('button, [role="button"]')).filter((b) => b !== closeBtnTarget);
        if (opts.length >= 3) {
          keepWorkingTarget = opts[opts.length - 1];
          break;
        }
        card = card.parentElement;
      }
    }

    if (!keepWorkingTarget && !closeBtnTarget) return null;
    return { keepWorkingTarget, closeBtnTarget };
  }

  // Automatically click "Continuar trabalhando" / "Keep working" (or Esc close button)
  // when Arena's Agent Mode shows "Esta tarefa foi bem-sucedida?" / "Isso conclui sua tarefa?" at the end of a turn!
  async function dismissTaskReviewPanelInMainWorld() {
    const found = findTaskReviewPanelInMainWorld();
    if (!found) return false;

    // Detach toolbarHost briefly so React 19 conditional fiber swap (<ReviewPanel/> -> <Composer/>) never hits an external sibling node!
    try {
      const tb = document.getElementById('arena-ultra-toolbar-host');
      if (tb) tb.remove();
    } catch (_) {}

    const { keepWorkingTarget, closeBtnTarget } = found;

    if (keepWorkingTarget) {
      try {
        keepWorkingTarget.click();
      } catch (_) {}
      await sleep(240);
      if (!findTaskReviewPanelInMainWorld() && findComposerEditorElement()) return true;

      triggerFiberOnClickIfPresent(keepWorkingTarget);
      await sleep(240);
      if (!findTaskReviewPanelInMainWorld() && findComposerEditorElement()) return true;
    }

    if (closeBtnTarget) {
      try {
        closeBtnTarget.click();
      } catch (_) {}
      await sleep(220);
      if (!findTaskReviewPanelInMainWorld() && findComposerEditorElement()) return true;

      triggerFiberOnClickIfPresent(closeBtnTarget);
      await sleep(220);
      if (!findTaskReviewPanelInMainWorld() && findComposerEditorElement()) return true;
    }

    // Fallback #3: Trigger Arena's document-level "Escape" listener ("Esc ✕")
    if (typeof KeyboardEvent === 'function') {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      } catch (_) {}
      await sleep(240);
      if (!findTaskReviewPanelInMainWorld() && findComposerEditorElement()) return true;
    }

    return Boolean(findComposerEditorElement());
  }

  // Ensure React/Next.js hydration finished AND dismiss any Task Review Panel FIRST (even on Virtual Desktop 2!)
  async function waitForStableHydratedEditor(maxWaitMs = 7000) {
    const start = Date.now();
    let dismissAttempts = 0;
    let contentEditableSeenCount = 0;
    while (Date.now() - start < maxWaitMs) {
      // ALWAYS check and dismiss Task Review Panel FIRST — even if a hidden .tiptap exists in the DOM!
      if (findTaskReviewPanelInMainWorld() && dismissAttempts < 5) {
        dismissAttempts += 1;
        await dismissTaskReviewPanelInMainWorld();
        await sleep(160);
      }

      const el1 = findComposerEditorElement();
      if (el1 && !findTaskReviewPanelInMainWorld()) {
        if (el1.isContentEditable) contentEditableSeenCount += 1;
        const hasInstance =
          el1.tagName === 'TEXTAREA' ||
          Boolean(findProseMirrorView(el1)) ||
          Boolean(findTiptapEditorFromFiber(el1)) ||
          (el1.isContentEditable && contentEditableSeenCount >= 2);
        if (hasInstance) {
          await sleep(160);
          const el2 = findComposerEditorElement();
          if (el2 && el2 === el1 && el2.isConnected) {
            return el2;
          }
        }
      }
      await sleep(180);
    }
    return findComposerEditorElement();
  }

  function dispatchProseMirrorText(view, text) {
    if (!view || !view.state || !view.state.schema) return false;
    const { state } = view;
    const schema = state.schema;
    const pType = schema.nodes.paragraph;
    if (!pType) return false;

    const lines = String(text).split('\n');
    const paragraphs = lines.map((line) => {
      if (!line) return pType.create();
      return pType.create(null, schema.text(line));
    });

    const tr = state.tr.replaceWith(0, state.doc.content.size, paragraphs);
    view.dispatch(tr);
    return true;
  }

  // Pure JS state update — emits ZERO untrusted synthetic mouse/keyboard events to document (preserves reCAPTCHA v3 score!)
  function setEditorTextInMainWorld(text, targetEl) {
    const el = targetEl || findComposerEditorElement();
    if (!el) return { ok: false, reason: 'editor_not_found' };

    const clean = String(text || '');

    // 1. Tiptap Editor instance via React Fiber
    const tiptap = findTiptapEditorFromFiber(el);
    if (tiptap && tiptap.view) {
      try {
        if (dispatchProseMirrorText(tiptap.view, clean)) {
          return { ok: true, method: 'tiptap_fiber_view', el };
        }
      } catch (_) {}
      try {
        tiptap.commands.setContent(
          clean
            .split('\n')
            .map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
            .join(''),
          true
        );
        return { ok: true, method: 'tiptap_set_content', el };
      } catch (_) {}
    }

    // 2. Direct ProseMirror EditorView on DOM element (pmViewDesc.view)
    const pmView = findProseMirrorView(el);
    if (pmView) {
      try {
        if (dispatchProseMirrorText(pmView, clean)) {
          return { ok: true, method: 'prosemirror_view', el };
        }
      } catch (_) {}
    }

    // 3. Standard <textarea> or <input> with React _valueTracker reset
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      try {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const prevVal = el.value;
        if (desc && desc.set) desc.set.call(el, clean);
        else el.value = clean;
        if (el._valueTracker) {
          el._valueTracker.setValue(prevVal);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, method: 'textarea_setter', el };
      } catch (_) {}
    }

    // 4. Native ContentEditable execCommand('insertText') — works universally across Tiptap, ProseMirror, Lexical & React 19!
    if (el.isContentEditable) {
      try {
        el.focus();
        document.execCommand('selectAll', false, null);
        const inserted = document.execCommand('insertText', false, clean);
        if (inserted && getEditorCurrentText().length > 0) {
          return { ok: true, method: 'contenteditable_exec_command', el };
        }
        el.textContent = clean;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: clean }));
        return { ok: true, method: 'contenteditable_input_event', el };
      } catch (_) {}
    }

    return { ok: false, reason: 'editor_instance_not_hydrated_yet' };
  }

  function findSendButtonInMainWorld(editorEl) {
    const composerCard =
      (editorEl &&
        (editorEl.closest('.bg-surface-secondary') ||
          editorEl.closest('form') ||
          editorEl.closest('[class*="rounded-"]'))) ||
      document;

    const selectors = [
      'button[aria-label="Send message"]:not([disabled]):not([aria-disabled="true"])',
      'button[aria-label*="Send" i]:not([disabled]):not([aria-disabled="true"])',
      'button[aria-label*="Submit" i]:not([disabled]):not([aria-disabled="true"])',
      'button[aria-label*="Enviar" i]:not([disabled]):not([aria-disabled="true"])',
      'button[type="submit"]:not([disabled]):not([aria-disabled="true"])'
    ];

    for (const sel of selectors) {
      const btn = composerCard.querySelector(sel) || document.querySelector(sel);
      if (
        btn &&
        !btn.disabled &&
        btn.getAttribute('aria-disabled') !== 'true' &&
        !btn.closest('#arena-ultra-root') &&
        !btn.closest('#arena-ultra-toolbar-host')
      ) {
        return btn;
      }
    }

    const allBtns = Array.from(
      composerCard.querySelectorAll('button:not([disabled]):not([aria-disabled="true"])')
    ).filter((b) => !b.closest('#arena-ultra-root') && !b.closest('#arena-ultra-toolbar-host'));
    for (const b of allBtns) {
      const pathEl = b.querySelector('svg path[d*="M3 12L21 12"], svg path[d*="12 19V5"], svg path[d*="M5 12h14"]');
      if (pathEl) return b;
    }

    return null;
  }

  function getEditorCurrentText() {
    const el = findComposerEditorElement();
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return (el.value || '').trim();
    return (el.innerText || '').replace(/\u200B/g, '').trim();
  }

  function isTrulyVisibleChallengeFrame(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest && (el.closest('.grecaptcha-badge') || el.closest('#arena-ultra-root') || el.closest('#arena-ultra-toolbar-host'))) {
      return false;
    }
    if (typeof window.getComputedStyle === 'function') {
      let cur = el;
      for (let d = 0; d < 10 && cur && cur.nodeType === 1; d++) {
        const st = window.getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') return false;
        if (Number(st.opacity) <= 0.05) return false;
        cur = cur.parentElement;
      }
    }
    if (!el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 2560;
    const vh = window.innerHeight || 1440;
    return r.width > 0 && r.height > 0 && r.left >= -5 && r.top >= -5 && r.left < vw && r.top < vh;
  }

  function isSecurityVerificationModalOpen() {
    try {
      // 1. Check ONLY real modal dialogs ([role="dialog"] / [role="alertdialog"]) — NEVER [data-state="open"] or body.innerText!
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
      for (const d of dialogs) {
        if (!d || !d.isConnected) continue;
        if (
          d.closest &&
          (d.closest('#arena-ultra-root') ||
            d.closest('#arena-ultra-toolbar-host') ||
            d.closest('[data-message-author-role], article, .prose'))
        ) {
          continue;
        }
        if (!isElementDisplayed(d)) continue;
        if (typeof window.getComputedStyle === 'function') {
          const st = window.getComputedStyle(d);
          if (Number(st.opacity) <= 0.05 || st.pointerEvents === 'none') continue;
        }
        const dr = d.getBoundingClientRect ? d.getBoundingClientRect() : { width: 300, height: 200 };
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
      const challengeFrames = Array.from(
        document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]')
      );
      for (const f of challengeFrames) {
        if (isTrulyVisibleChallengeFrame(f)) {
          const r = f.getBoundingClientRect();
          if (r.width >= 280 && r.height >= 350 && r.top >= 0 && r.left >= 0) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function dispatchRadixPress(el) {
    if (!el) return;
    try {
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(
          new PointerEvent('pointerenter', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        );
        el.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        );
        el.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
          })
        );
      }
      if (typeof MouseEvent === 'function') {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
      }
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 0,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
          })
        );
      }
      if (typeof MouseEvent === 'function') {
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0 }));
      }
      el.click();
    } catch (_) {}
  }

  function triggerFiberSelectOrClick(el) {
    let cur = el;
    for (let d = 0; d < 5 && cur; d++) {
      const keys = Object.keys(cur);
      const propsKey = keys.find((k) => k.startsWith('__reactProps$'));
      if (propsKey && cur[propsKey]) {
        const p = cur[propsKey];
        if (typeof p.onSelect === 'function') {
          try {
            p.onSelect({ preventDefault() {}, stopPropagation() {} });
            return true;
          } catch (_) {}
        }
        if (typeof p.onClick === 'function') {
          try {
            p.onClick({ preventDefault() {}, stopPropagation() {}, button: 0, ctrlKey: false, target: cur, currentTarget: cur });
            return true;
          } catch (_) {}
        }
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function findCurrentSidebarChatRow(convId) {
    const roots = Array.from(document.querySelectorAll('aside, nav, [data-sidebar], [class*="sidebar" i]'));
    const scopeList = roots.length ? roots : [document];

    for (const root of scopeList) {
      // 1. Exact conversation UUID link match (/agent/<uuid> or /c/<uuid>)
      if (convId) {
        const links = Array.from(root.querySelectorAll('a[href]'));
        const exactLink = links.find((a) => {
          const href = a.getAttribute('href') || '';
          return href.includes(`/${convId}`);
        });
        if (exactLink) {
          return (
            exactLink.closest('li, [data-sidebar="menu-item"], div.group') ||
            exactLink.parentElement ||
            exactLink
          );
        }
      }

      // 2. Active current page item in sidebar (aria-current="page" or data-active="true")
      const activeEl = root.querySelector(
        'a[aria-current="page"], [data-sidebar="menu-button"][data-active="true"], [data-active="true"] a[href*="/agent/"], [data-active="true"] a[href*="/c/"]'
      );
      if (activeEl) {
        return activeEl.closest('li, [data-sidebar="menu-item"], div.group') || activeEl.parentElement || activeEl;
      }
    }
    return null;
  }

  function findMoreOptionsButtonInRow(rowEl) {
    if (!rowEl) return null;
    const moreRx = /^(?:more options|mais op[çc][õo]es|m[áa]s opciones|plus d['’]options|weitere optionen|options|op[çc][õo]es)$/i;
    const searchContainers = [rowEl, rowEl.parentElement].filter(Boolean);

    for (const box of searchContainers) {
      const btns = Array.from(box.querySelectorAll('button, [role="button"]')).filter(
        (b) => !b.closest('#arena-ultra-root') && !b.closest('#arena-ultra-toolbar-host')
      );
      for (const b of btns) {
        const aria = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        const srTxt = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (moreRx.test(aria) || moreRx.test(srTxt)) return b;
      }
      for (const b of btns) {
        if (
          b.getAttribute('aria-haspopup') === 'menu' ||
          b.querySelector('svg.lucide-ellipsis, svg.lucide-more-horizontal, svg[class*="ellipsis" i], svg[class*="more" i]') ||
          srTxtIsDots(b)
        ) {
          return b;
        }
      }
    }
    return null;
  }

  function srTxtIsDots(el) {
    const t = (el.textContent || '').trim();
    return t === '...' || t === '⋯' || t === '•••';
  }

  function findOpenArchiveMenuItem() {
    const archiveRx = /^(?:archive|arquivar|archivar|archiver|archivieren)$/i;
    const menus = Array.from(
      document.querySelectorAll('[role="menu"], [data-radix-menu-content], [data-radix-popper-content-wrapper]')
    );
    for (const menu of menus) {
      if (!isElementDisplayed(menu)) continue;
      const items = Array.from(menu.querySelectorAll('[role="menuitem"], button, div[tabindex], a'));
      for (const item of items) {
        const txt = (item.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 40) continue;
        if (/unarchive|desarquivar|rename|renomear|delete|excluir/i.test(txt)) continue;
        if (archiveRx.test(txt) || item.querySelector('svg.lucide-archive, svg[class*="archive" i]')) {
          return item;
        }
      }
    }
    return null;
  }

  function isSidebarCollapsedInDom() {
    const sb = document.querySelector('[data-sidebar="sidebar"], [data-state="collapsed"][data-collapsible], aside');
    if (!sb) return false;
    const stateAttr = (sb.getAttribute('data-state') || '').toLowerCase();
    const collAttr = (sb.getAttribute('data-collapsible') || '').toLowerCase();
    if (stateAttr === 'collapsed' || collAttr === 'icon' || collAttr === 'offcanvas') {
      return true;
    }
    if (!document.hidden && window.innerWidth > 0 && typeof sb.getBoundingClientRect === 'function') {
      const r = sb.getBoundingClientRect();
      if (r.width > 0 && r.width < 80) return true;
    }
    return false;
  }

  function findSidebarToggleBtn() {
    const toggleCandidates = Array.from(
      document.querySelectorAll(
        'button[data-sidebar="trigger"], button[aria-label*="sidebar" i], button[aria-label*="barra lateral" i], header button, nav button'
      )
    );
    return (
      toggleCandidates.find(
        (b) =>
          !b.closest('#arena-ultra-root') &&
          (b.getAttribute('data-sidebar') === 'trigger' ||
            /sidebar|barra lateral/i.test(b.getAttribute('aria-label') || '') ||
            Boolean(b.querySelector('svg.lucide-panel-left, svg.lucide-panel-left-open, svg[class*="panel-left" i]')))
      ) || null
    );
  }

  async function directArchiveAgenticSessionById(convId) {
    const cleanId = String(convId || '').trim();
    if (!cleanId) return { ok: false, reason: 'missing_conv_id' };
    const rawFetch = window.__AU_NATIVE_FETCH__ || window.fetch.bind(window);
    const delays = [0, 450, 950, 1600];
    let lastStatus = 0;

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        await sleep(delays[attempt]);
      }
      bridgeState.inFlightArchiveFetches += 1;
      try {
        const res = await rawFetch(`/api/chat/${encodeURIComponent(cleanId)}/archive`, {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { Accept: 'application/json' }
        });
        lastStatus = res.status;
        if (res.ok || res.status === 204) {
          // Hide row immediately in sidebar DOM if currently rendered
          try {
            const links = document.querySelectorAll(`a[href*="${CSS.escape ? CSS.escape(cleanId) : cleanId}"]`);
            links.forEach((a) => {
              const li = a.closest('li, [data-sidebar="menu-item"]') || a;
              if (li && li.style) li.style.display = 'none';
            });
          } catch (_) {}
          return { ok: true, archived: true, method: 'api_direct', convId: cleanId };
        }
        // Only retry on transient statuses (404 while DB row commits right after create-chat, 409, 429, 5xx)
        if (res.status !== 404 && res.status !== 409 && res.status !== 425 && res.status !== 429 && res.status < 500) {
          break;
        }
      } catch (_) {
        lastStatus = -1;
      } finally {
        bridgeState.inFlightArchiveFetches = Math.max(0, bridgeState.inFlightArchiveFetches - 1);
      }
    }

    return { ok: false, reason: `api_archive_status_${lastStatus}`, convId: cleanId };
  }

  async function waitForInFlightArchivesToSettle(maxWaitMs = 2800) {
    const start = Date.now();
    while (bridgeState.inFlightArchiveFetches > 0 && Date.now() - start < maxWaitMs) {
      await sleep(90);
    }
  }

  async function archiveCurrentChatInMainWorld(explicitConvId) {
    let convId = String(explicitConvId || '').trim();
    let isAgentic = /^\/agent(?:\b|\/)/i.test(location.pathname || '');

    // Wait up to ~2.1s if Arena is still transitioning URL from /agent -> /agent/<uuid> right after first POST
    if (!convId) {
      for (let w = 0; w < 15; w++) {
        const m = (location.pathname || '').match(/\/(agent|c|chat|s|t)\/([A-Za-z0-9_-]{3,})/i);
        if (m && m[2]) {
          isAgentic = m[1].toLowerCase() === 'agent';
          convId = m[2];
          break;
        }
        if (bridgeState.lastCreatedConvId) {
          convId = bridgeState.lastCreatedConvId;
          isAgentic = true;
          break;
        }
        await sleep(140);
      }
    }

    // 1. PRIMARY ENGINE: Direct same-origin Arena API (`POST /api/chat/:id/archive` with keepalive + retry!)
    // Immune to hidden/grouped tabs (where Arena's visibilitychange closes Radix menus!), closed sidebars, and page navigation!
    if (convId && isAgentic) {
      const apiRes = await directArchiveAgenticSessionById(convId);
      if (apiRes.ok) {
        return apiRes;
      }
    }

    // 2. FALLBACK ENGINE: Sidebar "..." -> "Archive" UI clicker (used for /c/<id> evaluation chats or if API route changes)
    const zenStyle =
      document.getElementById('arena-ultra-page-theme') || document.getElementById('arena-ultra-theme-style');
    const prevZenDisabled = zenStyle ? zenStyle.disabled : false;
    if (zenStyle) zenStyle.disabled = true;

    let toggledSidebarBtn = null;
    try {
      let row = findCurrentSidebarChatRow(convId);

      // Expand sidebar if collapsed (including shadcn sidebars where links stay hidden in DOM with data-state="collapsed"!)
      if (!row || !isElementDisplayed(row) || isSidebarCollapsedInDom() || !findMoreOptionsButtonInRow(row)) {
        const sbToggle = findSidebarToggleBtn();
        if (sbToggle && (!row || !isElementDisplayed(row) || isSidebarCollapsedInDom())) {
          toggledSidebarBtn = sbToggle;
          dispatchRadixPress(sbToggle);
          await sleep(180);
        }
      }

      // Poll up to ~2.1s in case Arena's SWR sidebar history is still inserting the brand-new chat right after Stop!
      for (let poll = 0; poll < 11; poll++) {
        if (!convId) {
          const m = (location.pathname || '').match(/\/(?:agent|c|chat|s|t)\/([A-Za-z0-9_-]{3,})/i);
          if (m && m[1]) convId = m[1];
          else if (bridgeState.lastCreatedConvId) convId = bridgeState.lastCreatedConvId;
        }
        row = findCurrentSidebarChatRow(convId);
        if (row && findMoreOptionsButtonInRow(row)) break;
        await sleep(190);
      }

      if (!row) {
        // Last-chance direct API attempt if convId appeared late during polling
        if (convId) {
          const lateApi = await directArchiveAgenticSessionById(convId);
          if (lateApi.ok) return lateApi;
        }
        return { ok: false, reason: 'sidebar_chat_row_not_found', convId };
      }

      // Hover the row so group-hover three-dots button becomes visible & interactive
      try {
        if (typeof PointerEvent === 'function') {
          row.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
        }
        if (typeof MouseEvent === 'function') {
          row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }
      } catch (_) {}
      await sleep(70);

      const moreBtn = findMoreOptionsButtonInRow(row);
      if (!moreBtn) {
        return { ok: false, reason: 'more_options_button_not_found', convId };
      }

      const prevStyle = moreBtn.getAttribute('style');
      moreBtn.style.setProperty('display', 'inline-flex', 'important');
      moreBtn.style.setProperty('visibility', 'visible', 'important');
      moreBtn.style.setProperty('opacity', '1', 'important');
      moreBtn.style.setProperty('pointer-events', 'auto', 'important');

      dispatchRadixPress(moreBtn);

      let archiveItem = null;
      for (let mTry = 0; mTry < 9; mTry++) {
        await sleep(95);
        archiveItem = findOpenArchiveMenuItem();
        if (archiveItem) break;
        if (mTry === 2) {
          try {
            moreBtn.focus();
            if (typeof KeyboardEvent === 'function') {
              moreBtn.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true })
              );
            }
          } catch (_) {}
        }
        if (mTry === 5) {
          triggerFiberOnClickIfPresent(moreBtn);
        }
      }

      if (prevStyle === null) moreBtn.removeAttribute('style');
      else moreBtn.setAttribute('style', prevStyle);

      if (!archiveItem) {
        try {
          if (typeof KeyboardEvent === 'function') {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
          }
        } catch (_) {}
        return { ok: false, reason: 'archive_menuitem_not_found', convId };
      }

      // Click "Archive" once cleanly (avoid double-firing conflicting handlers)
      if (!triggerFiberSelectOrClick(archiveItem)) {
        dispatchRadixPress(archiveItem);
      }

      await sleep(170);
      try {
        const confirmDialogs = Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]'));
        for (const dlg of confirmDialogs) {
          if (!isElementDisplayed(dlg)) continue;
          const confirmBtn = Array.from(dlg.querySelectorAll('button')).find((b) =>
            /^(?:archive|arquivar|confirm|confirmar)$/i.test((b.textContent || '').trim())
          );
          if (confirmBtn) {
            dispatchRadixPress(confirmBtn);
            break;
          }
        }
      } catch (_) {}

      // Wait for actual archive fetch / Server Action to finish so navigation never aborts it!
      await sleep(260);
      await waitForInFlightArchivesToSettle(2800);
      await sleep(180);
      return { ok: true, archived: true, method: 'ui_menu', convId };
    } finally {
      if (toggledSidebarBtn) {
        try {
          dispatchRadixPress(toggledSidebarBtn);
        } catch (_) {}
      }
      if (zenStyle) zenStyle.disabled = prevZenDisabled;
    }
  }

  function bytesToBase64InBridge(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytesInBridge(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // DATA-03: Separate always-excluded ephemeral dirs from root-only build output dirs
  const CAS_ALWAYS_IGNORED_DIRS = new Set([
    '.git',
    'node_modules',
    '__pycache__',
    '.venv',
    'venv',
    '.nuxt',
    '.cache',
    '.local',
    '.npm',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    'Unselected files'
  ]);
  const CAS_ROOT_ONLY_IGNORED_DIRS = new Set([
    '.next',
    'dist',
    'build',
    'out',
    'target',
    'coverage'
  ]);
  const CAS_IGNORED_FILES = new Set([
    '.gitconfig',
    '.git-credentials',
    '.netrc',
    'au_git_askpass.sh',
    'au_gh',
    'au_chat'
  ]);

  // ARENA-07: Multi-modal file & image attachment injection via DataTransfer (input[type="file"] + Tiptap paste/drop)
  async function attachFilesInMainWorld(rawAttachments, targetEditor) {
    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
      return { ok: true, attachedCount: 0 };
    }
    if (rawAttachments.length > 10) {
      return { ok: false, reason: 'too_many_attachments_max_10' };
    }
    if (typeof DataTransfer !== 'function' || typeof File !== 'function') {
      return { ok: false, reason: 'datatransfer_unsupported' };
    }

    const dt = new DataTransfer();
    for (const item of rawAttachments) {
      if (!item || !item.name) continue;
      let bytes;
      if (typeof item.base64 === 'string' && item.base64) {
        bytes = base64ToBytesInBridge(item.base64);
      } else if (typeof item.content === 'string') {
        bytes = new TextEncoder().encode(item.content);
      } else {
        continue;
      }
      if (bytes.byteLength > 20 * 1024 * 1024) {
        return { ok: false, reason: `attachment_exceeds_20mb:${item.name}` };
      }
      const mime = item.mimeType || item.type || 'application/octet-stream';
      const fileObj = new File([bytes], String(item.name), { type: mime, lastModified: Date.now() });
      dt.items.add(fileObj);
    }

    if (dt.files.length === 0) {
      return { ok: false, reason: 'no_valid_attachments' };
    }

    const editor = targetEditor || findComposerEditorElement();
    const scope = (editor && editor.closest && (editor.closest('form') || editor.closest('main'))) || document;
    const fileInput = scope.querySelector && scope.querySelector('input[type="file"]');

    let delivered = false;
    if (fileInput) {
      try {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        delivered = true;
      } catch (_) {}
    }

    if (!delivered && editor) {
      try {
        const pasteEvt = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        editor.dispatchEvent(pasteEvt);
        delivered = true;
      } catch (_) {}
      try {
        const dropEvt = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt
        });
        editor.dispatchEvent(dropEvt);
        delivered = true;
      } catch (_) {}
    }

    await sleep(220);
    return { ok: delivered, attachedCount: delivered ? dt.files.length : 0 };
  }

  // ARENA-15 + DATA-02 + DATA-03: Explicit complete|partial|failed workspace export with omitted reasons & modes
  async function exportWorkspaceInMainWorld(preferRepoSubdir = true) {
    const f = window.__AU_NATIVE_FETCH__ || window.fetch.bind(window);
    const cleanUrl = (location.origin + location.pathname).replace(/\/+$/, '');
    const convMatch = (location.pathname || '').match(/\/(?:agent|c|chat|s|t)\/([A-Za-z0-9_-]{3,})/i);
    const convId = (convMatch && convMatch[1]) || bridgeState.lastCreatedConvId || '';

    // Strategy 1: Legacy / direct /download-workspace ZIP endpoint
    if (/\/(?:agent|c)\/[A-Za-z0-9_-]{3,}/i.test(location.pathname || '')) {
      try {
        const zipRes = await f(`${cleanUrl}/download-workspace`, {
          method: 'GET',
          credentials: 'include'
        });
        if (zipRes && zipRes.ok) {
          const buf = await zipRes.arrayBuffer();
          const u8 = new Uint8Array(buf);
          if (u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b) {
            return {
              ok: true,
              exportStatus: 'complete',
              mode: 'zip',
              convId,
              byteLength: u8.length,
              bytes: u8.length,
              omitted: [],
              counts: { included: -1, omitted: 0 },
              base64Zip: bytesToBase64InBridge(u8)
            };
          }
        }
      } catch (_) {}
    }

    // Strategy 2: Live Arena Agent CAS Workspace Manifest (/api/chat/:id/workspace/latest?includeManifest=true + /api/chat/workspace/cas/user/:hash)
    if (!convId) {
      return { ok: false, exportStatus: 'failed', omitted: [], counts: { included: 0, omitted: 0 }, bytes: 0, reason: 'no_session_id' };
    }

    try {
      const manRes = await f(
        `/api/chat/${encodeURIComponent(convId)}/workspace/latest?includeManifest=true`,
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store'
        }
      );
      if (!manRes || !manRes.ok) {
        return {
          ok: false,
          exportStatus: 'failed',
          httpStatus: manRes ? manRes.status : 0,
          omitted: [],
          counts: { included: 0, omitted: 0 },
          bytes: 0,
          reason: 'workspace_manifest_unavailable'
        };
      }
      const manJson = await manRes.json();
      const root = manJson && manJson.manifest && manJson.manifest.root;
      if (!root || typeof root.entries !== 'object' || !root.entries) {
        return { ok: false, exportStatus: 'failed', omitted: [], counts: { included: 0, omitted: 0 }, bytes: 0, reason: 'empty_workspace_manifest' };
      }

      const rawEntries = [];
      const omitted = [];
      let totalPlannedBytes = 0;
      const MAX_FILES = 400;
      const MAX_BYTES = 35 * 1024 * 1024;

      function isIgnoredCasDir(name, relPrefix) {
        if (CAS_ALWAYS_IGNORED_DIRS.has(name)) return true;
        // Root-only or immediate repo/ root for build/dist/target/out/coverage (DATA-03)
        const isRootDepth = !relPrefix || relPrefix === 'repo';
        if (isRootDepth && CAS_ROOT_ONLY_IGNORED_DIRS.has(name)) return true;
        return false;
      }

      async function collectDirEntries(dirNode, prefix) {
        if (!dirNode || typeof dirNode.entries !== 'object' || !dirNode.entries) return;
        for (const [name, entry] of Object.entries(dirNode.entries)) {
          if (!name || name === '.' || name === '..' || !entry || typeof entry !== 'object') continue;
          const relPath = prefix ? `${prefix}/${name}` : name;

          if (rawEntries.length >= MAX_FILES) {
            omitted.push({ path: relPath, reason: 'max_files_cap' });
            continue;
          }
          if (totalPlannedBytes >= MAX_BYTES) {
            omitted.push({ path: relPath, reason: 'max_bytes_cap' });
            continue;
          }

          if (entry.type === 'dir') {
            if (isIgnoredCasDir(name, prefix)) continue;
            await collectDirEntries(entry, relPath);
          } else if (entry.type === 'dirRef' && typeof entry.hash === 'string' && entry.hash) {
            if (isIgnoredCasDir(name, prefix)) continue;
            try {
              const dr = await f(`/api/chat/workspace/cas/user/${encodeURIComponent(entry.hash)}`, {
                method: 'GET',
                credentials: 'include'
              });
              if (dr && dr.ok) {
                const subDir = await dr.json();
                await collectDirEntries(subDir, relPath);
              } else {
                omitted.push({ path: relPath, reason: 'cas_dirref_http_' + (dr ? dr.status : 0) });
              }
            } catch (_) {
              omitted.push({ path: relPath, reason: 'cas_dirref_fetch_failed' });
            }
          } else if (entry.type === 'symlink') {
            if (typeof entry.target === 'string') {
              rawEntries.push({ path: relPath, entry, gitMode: '120000' });
            } else {
              omitted.push({ path: relPath, reason: 'unresolved_symlink' });
            }
          } else if (entry.type === 'text' || entry.type === 'image' || entry.type === 'video' || entry.type === 'binary') {
            if (CAS_IGNORED_FILES.has(name) || prefix === 'au_state' || relPath.startsWith('au_state/')) continue;
            const sz = Number(entry.size || 0);
            if (sz > 15 * 1024 * 1024) {
              omitted.push({ path: relPath, reason: 'file_exceeds_15mb' });
              continue;
            }
            if (totalPlannedBytes + sz > MAX_BYTES) {
              omitted.push({ path: relPath, reason: 'max_bytes_cap' });
              continue;
            }
            totalPlannedBytes += sz;
            const gitMode =
              entry.mode === '120000' || entry.mode === '100755'
                ? entry.mode
                : entry.executable === true || (typeof entry.permissions === 'number' && (entry.permissions & 0o111) !== 0)
                  ? '100755'
                  : '100644';
            rawEntries.push({ path: relPath, entry, gitMode });
          }
        }
      }

      await collectDirEntries(root, '');
      if (!rawEntries.length) {
        return {
          ok: false,
          exportStatus: 'failed',
          omitted,
          counts: { included: 0, omitted: omitted.length },
          bytes: 0,
          reason: 'no_workspace_files'
        };
      }

      let targetEntries = rawEntries;
      let targetOmitted = omitted;
      if (preferRepoSubdir) {
        const repoSub = rawEntries.filter((it) => it.path.startsWith('repo/') && it.path.length > 5);
        if (repoSub.length > 0) {
          targetEntries = repoSub.map((it) => ({
            path: it.path.slice(5),
            entry: it.entry,
            gitMode: it.gitMode
          }));
          targetOmitted = omitted
            .filter((o) => o.path === 'repo' || o.path.startsWith('repo/'))
            .map((o) => ({ path: o.path.startsWith('repo/') ? o.path.slice(5) : o.path, reason: o.reason }));
        }
      }

      const outFiles = [];
      let exportedBytes = 0;
      const batchSize = 6;
      for (let i = 0; i < targetEntries.length; i += batchSize) {
        const slice = targetEntries.slice(i, i + batchSize);
        const resolved = await Promise.all(
          slice.map(async ({ path, entry, gitMode }) => {
            if (entry.type === 'symlink' && typeof entry.target === 'string') {
              exportedBytes += entry.target.length;
              return { path, content: entry.target, mode: '120000' };
            }
            if (entry.type === 'text' && typeof entry.inlineText === 'string') {
              exportedBytes += entry.inlineText.length;
              return { path, content: entry.inlineText, mode: gitMode || '100644' };
            }
            if (!entry.hash) {
              targetOmitted.push({ path, reason: 'missing_cas_hash' });
              return null;
            }
            try {
              const casRes = await f(`/api/chat/workspace/cas/user/${encodeURIComponent(entry.hash)}`, {
                method: 'GET',
                credentials: 'include'
              });
              if (!casRes || !casRes.ok) {
                targetOmitted.push({ path, reason: 'cas_blob_http_' + (casRes ? casRes.status : 0) });
                return null;
              }
              const ab = await casRes.arrayBuffer();
              const u8 = new Uint8Array(ab);
              exportedBytes += u8.byteLength;
              return { path, base64: bytesToBase64InBridge(u8), mode: gitMode || '100644' };
            } catch (_) {
              targetOmitted.push({ path, reason: 'cas_blob_fetch_failed' });
              return null;
            }
          })
        );
        for (const item of resolved) {
          if (item) outFiles.push(item);
        }
      }

      if (!outFiles.length) {
        return {
          ok: false,
          exportStatus: 'failed',
          omitted: targetOmitted,
          counts: { included: 0, omitted: targetOmitted.length },
          bytes: 0,
          reason: 'cas_blobs_empty'
        };
      }
      const exportStatus = targetOmitted.length > 0 ? 'partial' : 'complete';
      return {
        ok: true,
        exportStatus,
        mode: 'cas',
        convId,
        fileCount: outFiles.length,
        omitted: targetOmitted,
        counts: { included: outFiles.length, omitted: targetOmitted.length },
        bytes: exportedBytes,
        files: outFiles
      };
    } catch (err) {
      return {
        ok: false,
        exportStatus: 'failed',
        omitted: [],
        counts: { included: 0, omitted: 0 },
        bytes: 0,
        reason: (err && err.message) || 'cas_export_failed'
      };
    }
  }

  // SEC-07: Strict allowlist of MAIN-world bridge commands
  const ALLOWED_BRIDGE_ACTIONS = new Set([
    'export_workspace',
    'archive_current_chat',
    'archive_conv_ids',
    'set_text',
    'set_and_submit',
    'attach_files',
    'ping_capabilities'
  ]);

  async function handleBridgeCommand(cmd) {
    const requestId = cmd && cmd.requestId;
    if (!requestId) return;
    if (!cmd.action || !ALLOWED_BRIDGE_ACTIONS.has(cmd.action)) {
      emitCommandResult({ requestId, ok: false, reason: 'disallowed_bridge_action' });
      return;
    }
    bridgeState.inCommand += 1;
    try {
      if (cmd.action === 'ping_capabilities') {
        const ed = findComposerEditorElement();
        emitCommandResult({
          requestId,
          ok: true,
          version: BRIDGE_VERSION,
          hasEditor: Boolean(ed),
          hasTiptap: Boolean(ed && (findTiptapEditorFromFiber(ed) || findProseMirrorView(ed))),
          convId: bridgeState.lastCreatedConvId || ''
        });
        return;
      }

      if (cmd.action === 'export_workspace') {
        const preferRepo = cmd.text !== 'raw_workspace';
        const wsRes = await exportWorkspaceInMainWorld(preferRepo);
        emitCommandResult(Object.assign({ requestId }, wsRes));
        return;
      }

      if (cmd.action === 'archive_current_chat') {
        const archRes = await archiveCurrentChatInMainWorld(cmd.text || '');
        emitCommandResult(Object.assign({ requestId }, archRes));
        return;
      }

      if (cmd.action === 'archive_conv_ids') {
        const ids = String(cmd.text || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const archivedIds = [];
        for (const id of ids) {
          const r = await directArchiveAgenticSessionById(id);
          if (r.ok) archivedIds.push(id);
        }
        emitCommandResult({ requestId, ok: archivedIds.length > 0, archivedIds });
        return;
      }

      if (isSecurityVerificationModalOpen()) {
        emitCommandResult({ requestId, ok: false, captchaTriggered: true, reason: 'security_verification' });
        return;
      }

      const stableEditor = await waitForStableHydratedEditor(cmd.action === 'set_text' ? 1500 : 4000);
      if (!stableEditor) {
        emitCommandResult({ requestId, ok: false, reason: 'editor_not_found' });
        return;
      }

      if (cmd.action === 'attach_files') {
        const attRes = await attachFilesInMainWorld(cmd.attachments || [], stableEditor);
        emitCommandResult(Object.assign({ requestId }, attRes));
        return;
      }

      if (cmd.action === 'set_text') {
        const res = setEditorTextInMainWorld(cmd.text || '', stableEditor);
        emitCommandResult({ requestId, ok: res.ok, method: res.method, reason: res.reason });
        return;
      }

      if (cmd.action === 'set_and_submit') {
        const postsBefore = bridgeState.chatPostCounter;
        const pathBefore = location.pathname;

        if (Array.isArray(cmd.attachments) && cmd.attachments.length > 0) {
          const attRes = await attachFilesInMainWorld(cmd.attachments, stableEditor);
          if (!attRes.ok) {
            emitCommandResult({ requestId, ok: false, reason: attRes.reason || 'attachment_failed' });
            return;
          }
        }

        const setRes = setEditorTextInMainWorld(cmd.text || '', stableEditor);
        if (!setRes.ok) {
          emitCommandResult({ requestId, ok: false, reason: setRes.reason || 'editor_not_ready' });
          return;
        }

        // Verify text actually stayed in the editor (wasn't wiped by late React mount)
        await sleep(160);
        if (getEditorCurrentText().length === 0 && String(cmd.text || '').trim().length > 0) {
          const retrySet = setEditorTextInMainWorld(cmd.text || '');
          if (!retrySet.ok) {
            emitCommandResult({ requestId, ok: false, reason: 'hydration_wiped_retry' });
            return;
          }
        }

        // Wait up to 2.8s for React to remove `disabled` on "Send message"
        let sendBtn = null;
        for (let i = 0; i < 28; i++) {
          await sleep(90);
          sendBtn = findSendButtonInMainWorld(setRes.el);
          if (sendBtn && !sendBtn.disabled) break;
          if (i === 4 && setRes.el && setRes.el.isContentEditable && String(cmd.text || '').length > 0) {
            try {
              setRes.el.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, String(cmd.text || ''));
            } catch (_) {}
          }
        }

        const submitStartedAt = Date.now();
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          const onSubmitFn = findComposerOnSubmitFromFiber(setRes.el);
          if (typeof onSubmitFn === 'function') {
            onSubmitFn({ preventDefault() {} });
          } else {
            emitCommandResult({ requestId, ok: false, reason: 'send_button_remained_disabled' });
            return;
          }
        }

        // Verify submission genuinely started (POST fired, URL changed, editor cleared, or Captcha modal opened)
        for (let check = 0; check < 14; check++) {
          await sleep(110);
          if (isSecurityVerificationModalOpen()) {
            emitCommandResult({ requestId, ok: false, captchaTriggered: true, reason: 'security_verification' });
            return;
          }
          if (bridgeState.lastTransientErrorAt >= submitStartedAt) {
            emitCommandResult({
              requestId,
              ok: false,
              transientError: true,
              reason: bridgeState.lastTransientErrorReason || 'session_start_failed'
            });
            return;
          }
          const postFired = bridgeState.chatPostCounter > postsBefore || bridgeState.activeStreams > 0;
          const urlChanged = location.pathname !== pathBefore;
          const editorCleared = getEditorCurrentText().length === 0;
          if (postFired || urlChanged || editorCleared) {
            await sleep(260);
            if (isSecurityVerificationModalOpen()) {
              emitCommandResult({ requestId, ok: false, captchaTriggered: true, reason: 'security_verification' });
              return;
            }
            if (bridgeState.lastTransientErrorAt >= submitStartedAt) {
              emitCommandResult({
                requestId,
                ok: false,
                transientError: true,
                reason: bridgeState.lastTransientErrorReason || 'session_start_failed'
              });
              return;
            }
            emitCommandResult({ requestId, ok: true, method: setRes.method + '+verified' });
            return;
          }
        }

        emitCommandResult({ requestId, ok: false, reason: 'submission_not_started_yet' });
      }
    } catch (err) {
      emitCommandResult({ requestId, ok: false, reason: err && err.message ? err.message : String(err) });
    } finally {
      bridgeState.inCommand = Math.max(0, bridgeState.inCommand - 1);
    }
  }

  // SEC-07: Strict origin + source + 2-way CSPRNG sessionToken validation on window.postMessage
  window.addEventListener('message', (ev) => {
    if (window.__AU_PAGE_BRIDGE_VERSION__ !== BRIDGE_VERSION) return;
    if (!ev || ev.source !== window) return;
    if (location && location.origin && ev.origin !== location.origin) return;
    const msg = ev.data;
    if (!msg || !msg.__au_ipc_v2__ || msg.dir !== 'iso->main') return;

    // 2-way handshake initialization from ISOLATED content.js
    if (msg.event === 'au-bridge-handshake-init') {
      const isoNonce = msg.detail && typeof msg.detail.isoNonce === 'string' ? msg.detail.isoNonce : '';
      if (!isoNonce || isoNonce.length < 16 || isoNonce.length > 128) return;
      // Only initialize once per document session (prevents late page-script re-handshake overwrite!)
      if (!bridgeSessionToken) {
        bridgeSessionToken = `${isoNonce}:${mainBridgeNonce}`;
      } else if (!bridgeSessionToken.startsWith(`${isoNonce}:`)) {
        bridgeState.rejectedUntrustedMessages += 1;
        emitTelemetry({ type: 'untrusted_ipc_rejected', reason: 'handshake_rebind_denied' });
        return;
      }
      postToContentScript(
        'au-bridge-handshake-ack',
        { isoNonce, mainNonce: mainBridgeNonce, version: BRIDGE_VERSION },
        true
      );
      flushOutboundQueue();
      return;
    }

    if (!bridgeSessionToken || msg.token !== bridgeSessionToken) {
      bridgeState.rejectedUntrustedMessages += 1;
      if (bridgeSessionToken) {
        emitTelemetry({
          type: 'untrusted_ipc_rejected',
          event: String(msg.event || '').slice(0, 40),
          reason: 'invalid_or_missing_bridge_token'
        });
      }
      return;
    }

    if (msg.event === 'au-bg-sleep-res') {
      const id = msg.detail && msg.detail.id;
      if (id && pendingBgSleeps.has(id)) {
        const resolve = pendingBgSleeps.get(id);
        pendingBgSleeps.delete(id);
        resolve();
      }
      return;
    }

    if (msg.event === 'au-bridge-command' && msg.detail) {
      handleBridgeCommand(msg.detail);
    }
  });

  // --- Network Stream & HTTP 402 / 429 Observer ---
  function looksLikeChatRequest(urlStr, method) {
    if (!urlStr) return false;
    const m = String(method || 'GET').toUpperCase();
    if (m !== 'POST') return false;
    // Ignore telemetry, analytics, monitoring, Next.js assets, rubric feedback, unarchive, and security widget pings
    if (
      /(sentry|posthog|analytics|telemetry|ingest|vitals|metrics|rum|cdn-cgi|recaptcha|turnstile|hcaptcha|\/_next\/|\/log\b|\/ping\b|heartbeat|rubric-feedback|\/unarchive(?:\b|\/|\?|$))/i.test(
        urlStr
      )
    ) {
      return false;
    }
    return /\/(api|stream|chat|agent|eval|conversation|message|completion|turn|run|nextjs|c\/|realtime\/v\d+\/sessions|in\/append(?:\b|\/|\?|$))/i.test(
      urlStr
    );
  }

  function isStopAppendPayload(bodyRaw) {
    if (typeof bodyRaw !== 'string' || bodyRaw.length < 6 || bodyRaw.length > 4096) return false;
    if (!bodyRaw.includes('"stop"')) return false;
    try {
      const parsed = JSON.parse(bodyRaw);
      return Boolean(parsed && typeof parsed === 'object' && parsed.kind === 'stop');
    } catch (_) {
      return false;
    }
  }

  function extractUserPromptFromBody(bodyRaw) {
    if (typeof bodyRaw !== 'string' || bodyRaw.length < 4 || bodyRaw.length > 500000) return '';
    try {
      const parsed = JSON.parse(bodyRaw);
      if (!parsed || typeof parsed !== 'object' || parsed.kind === 'stop') return '';
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        return parsed.text.trim();
      }
      if (typeof parsed.content === 'string' && parsed.content.trim()) {
        return parsed.content.trim();
      }
      const msgObj =
        (parsed.message && typeof parsed.message === 'object' ? parsed.message : null) ||
        (parsed.data && typeof parsed.data === 'object' ? parsed.data : null) ||
        (parsed.payload && parsed.payload.message && typeof parsed.payload.message === 'object'
          ? parsed.payload.message
          : null);
      if (msgObj && Array.isArray(msgObj.parts)) {
        const txt = msgObj.parts
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n')
          .trim();
        if (txt) return txt;
      }
      if (msgObj && typeof msgObj.content === 'string' && msgObj.content.trim()) {
        return msgObj.content.trim();
      }
      if (msgObj && typeof msgObj.text === 'string' && msgObj.text.trim()) {
        return msgObj.text.trim();
      }
    } catch (_) {}
    return '';
  }

  function isSessionOrSendEndpoint(urlStr) {
    return /\/(?:nextjs-api\/stream\/create-chat|api\/coding-agent\/sessions|api\/v\d+\/sessions|api\/chat\/trigger-session|api\/chat\/trigger-token|api\/v\d+\/runs\/[^/]+\/(?:input|session)-streams\/wait|in\/append)(?:\b|\/|\?|$)/i.test(
      urlStr || ''
    );
  }

  if (typeof window.fetch === 'function') {
    if (!window.__AU_NATIVE_FETCH__) {
      window.__AU_NATIVE_FETCH__ = window.fetch.bind(window);
    }
    const baseFetch = window.__AU_NATIVE_FETCH__;

    window.fetch = async function (...args) {
      let urlStr = '';
      let method = 'GET';
      let reqBodyStr = '';
      let isNextAction = false;
      try {
        const req = args[0];
        const init = args[1] || {};
        if (typeof req === 'string') {
          urlStr = req;
          method = init.method || 'GET';
        } else if (req && typeof req === 'object') {
          urlStr = req.url || '';
          method = init.method || req.method || 'GET';
        }
        if (typeof init.body === 'string') {
          reqBodyStr = init.body;
        }
        if (init.headers) {
          const h = init.headers;
          if (typeof h.get === 'function' && h.get('Next-Action')) isNextAction = true;
          else if (typeof h === 'object' && (h['Next-Action'] || h['next-action'])) isNextAction = true;
        }
      } catch (_) {}

      const isArchiveNetCall =
        String(method).toUpperCase() === 'POST' &&
        (/\/archive(?:\b|\/|\?|$)/i.test(urlStr) || isNextAction);

      const isStopAppend = /in\/append/i.test(urlStr) && isStopAppendPayload(reqBodyStr);
      const tracked = !isStopAppend && looksLikeChatRequest(urlStr, method);
      const isCoreSessionPost = tracked && isSessionOrSendEndpoint(urlStr);

      if (tracked && !/\/archive(?:\b|\/|\?|$)/i.test(urlStr)) {
        // Count POST immediately for submit verification, without falsely claiming an active SSE stream yet!
        bridgeState.chatPostCounter += 1;
        if (reqBodyStr && /create-chat|coding-agent\/sessions|api\/v\d+\/sessions|in\/append/i.test(urlStr)) {
          const observedPrompt = extractUserPromptFromBody(reqBodyStr);
          if (observedPrompt) {
            emitTelemetry({
              type: 'user_prompt_observed',
              prompt: observedPrompt,
              isCreate: /create-chat|coding-agent\/sessions|api\/v\d+\/sessions/i.test(urlStr)
            });
          }
        }
      }

      if (isArchiveNetCall) {
        bridgeState.inFlightArchiveFetches += 1;
      }

      let response;
      try {
        response = await baseFetch(...args);
      } catch (fetchErr) {
        if (isArchiveNetCall) {
          bridgeState.inFlightArchiveFetches = Math.max(0, bridgeState.inFlightArchiveFetches - 1);
        }
        if (isCoreSessionPost) {
          const errMsg = (fetchErr && fetchErr.message) || 'Failed to start session (network/timeout)';
          bridgeState.lastTransientErrorAt = Date.now();
          bridgeState.lastTransientErrorReason = errMsg;
          emitTelemetry({
            type: 'transient_session_error',
            status: 0,
            endpoint: urlStr,
            reason: errMsg
          });
        }
        throw fetchErr;
      }

      if (isArchiveNetCall) {
        bridgeState.inFlightArchiveFetches = Math.max(0, bridgeState.inFlightArchiveFetches - 1);
      }

      if (tracked) {
        // Capture newly created session ID immediately (even before Next.js router updates location.pathname!)
        if (response.ok && /create-chat|coding-agent\/sessions/i.test(urlStr) && response.clone) {
          try {
            response
              .clone()
              .json()
              .then((data) => {
                const newId = (data && (data.id || data.sessionId)) || '';
                if (newId && typeof newId === 'string') {
                  bridgeState.lastCreatedConvId = newId;
                  emitTelemetry({ type: 'session_created', convId: newId });
                }
              })
              .catch(() => {});
          } catch (_) {}
        }

        if (response.status === 402) {
          emitTelemetry({
            type: 'http_limit',
            status: 402,
            reason: 'Créditos/cota esgotados (HTTP 402)'
          });
        } else if (response.status === 429 || response.status === 403) {
          emitTelemetry({
            type: 'http_rate_or_challenge',
            status: response.status,
            endpoint: urlStr,
            reason: 'Verificação de segurança ou cooldown temporário'
          });
          // If trigger-session or create-chat hit a transient 429 WITHOUT a Security Verification modal, report transient retryable failure too!
          if (response.status === 429 && isCoreSessionPost && response.clone) {
            try {
              response
                .clone()
                .text()
                .then((bodyTxt) => {
                  if (
                    /this session has reached its token usage limit|reached your daily limit|credits will refresh|out of credits|out of tokens/i.test(
                      bodyTxt || ''
                    )
                  ) {
                    emitTelemetry({
                      type: 'stream_limit_text',
                      reason: 'Limite diário de créditos/tokens atingido'
                    });
                  } else if (!isSecurityVerificationModalOpen()) {
                    bridgeState.lastTransientErrorAt = Date.now();
                    bridgeState.lastTransientErrorReason = 'Failed to start session (HTTP 429 cooldown)';
                    emitTelemetry({
                      type: 'transient_session_error',
                      status: 429,
                      endpoint: urlStr,
                      reason: 'Failed to start session (cooldown temporário HTTP 429)'
                    });
                  }
                })
                .catch(() => {});
            } catch (_) {}
          }
        } else if (!response.ok && isCoreSessionPost && response.status !== 401) {
          // 500, 502, 503, 504, 408, 404, 409, 400 on trigger-session / create-chat / trigger-token / in/append!
          if (response.clone) {
            try {
              response
                .clone()
                .text()
                .then((errBody) => {
                  if (
                    /this session has reached its token usage limit|reached your daily limit|credits will refresh|out of credits|out of tokens|banned/i.test(
                      errBody || ''
                    )
                  ) {
                    emitTelemetry({
                      type: 'stream_limit_text',
                      reason: 'Limite de créditos/tokens atingido'
                    });
                    return;
                  }
                  const reasonStr = `Failed to start session (HTTP ${response.status})`;
                  bridgeState.lastTransientErrorAt = Date.now();
                  bridgeState.lastTransientErrorReason = reasonStr;
                  emitTelemetry({
                    type: 'transient_session_error',
                    status: response.status,
                    endpoint: urlStr,
                    reason: reasonStr
                  });
                })
                .catch(() => {});
            } catch (_) {}
          } else {
            const reasonStr = `Failed to start session (HTTP ${response.status})`;
            bridgeState.lastTransientErrorAt = Date.now();
            bridgeState.lastTransientErrorReason = reasonStr;
            emitTelemetry({
              type: 'transient_session_error',
              status: response.status,
              endpoint: urlStr,
              reason: reasonStr
            });
          }
        }

        const contentType = ((response.headers && response.headers.get('content-type')) || '').toLowerCase();
        // Match genuine streaming responses (SSE / NDJSON / octet-stream / Vercel AI SDK text/plain / RSC x-component) — NOT regular application/json!
        const isTrueStream =
          response.ok &&
          response.body &&
          typeof response.body.getReader === 'function' &&
          /(event-stream|ndjson|octet-stream|text\/plain|x-component)/i.test(contentType);

        if (isTrueStream && response.clone) {
          try {
            const cloned = response.clone();
            const reader = cloned.body.getReader();
            const decoder = new TextDecoder();
            bridgeState.activeStreams += 1;
            bridgeState.lastChunkAt = Date.now();
            emitTelemetry({
              type: 'stream_start',
              activeStreams: bridgeState.activeStreams,
              timestamp: bridgeState.lastChunkAt
            });

            (async () => {
              let lastChunkEmitAt = 0;
              let reasoningEmitted = false;
              try {
                while (true) {
                  // Guard against permanently hung sockets (>90s with zero bytes; allows long silent reasoning & bash tools!)
                  // Always clear timeout immediately after each chunk so zero 90s timers accumulate in long sessions!
                  let chunkTimer = null;
                  const readResult = await Promise.race([
                    reader.read(),
                    new Promise((resolve) => {
                      chunkTimer = setTimeout(() => resolve({ timeout: true }), 90000);
                    })
                  ]);
                  if (chunkTimer) clearTimeout(chunkTimer);
                  if (!readResult || readResult.timeout || readResult.done) break;
                  const value = readResult.value;
                  const nowTs = Date.now();
                  bridgeState.lastChunkAt = nowTs;
                  if (value) {
                    const snippet = decoder.decode(value, { stream: true });
                    if (
                      !reasoningEmitted &&
                      /"type"\s*:\s*"reasoning-(?:start|delta)"/i.test(snippet)
                    ) {
                      reasoningEmitted = true;
                      emitTelemetry({
                        type: 'stream_reasoning_detected',
                        reason: 'Thinking... (SSE reasoning stream)'
                      });
                    }
                    if (
                      /this session has reached its token usage limit|reached your daily limit|credits will refresh|out of credits|no credits remaining|credit limit reached|out of tokens/i.test(
                        snippet
                      )
                    ) {
                      emitTelemetry({
                        type: 'stream_limit_text',
                        reason: 'Limite real de tokens/créditos recebido na stream'
                      });
                    } else if (
                      /failed to start (?:chat )?session|failed to create (?:chat|coding) (?:session|access token)|sandbox failed to start|stream connection retries exhausted|stopped chat response cannot be matched|the assistant crashed unexpectedly|the connection to the ai service was interrupted/i.test(
                        snippet
                      )
                    ) {
                      bridgeState.lastTransientErrorAt = nowTs;
                      bridgeState.lastTransientErrorReason = 'Failed to start session (stream)';
                      emitTelemetry({
                        type: 'transient_session_error',
                        status: 500,
                        endpoint: urlStr,
                        reason: 'Failed to start session (stream)'
                      });
                    }
                  }
                  if (nowTs - lastChunkEmitAt >= 250) {
                    lastChunkEmitAt = nowTs;
                    emitTelemetry({
                      type: 'stream_chunk',
                      activeStreams: bridgeState.activeStreams,
                      timestamp: nowTs
                    });
                  }
                }
              } catch (_) {
              } finally {
                try {
                  reader.cancel().catch(() => {});
                } catch (_) {}
                bridgeState.activeStreams = Math.max(0, bridgeState.activeStreams - 1);
                emitTelemetry({
                  type: 'stream_end',
                  activeStreams: bridgeState.activeStreams,
                  timestamp: Date.now()
                });
              }
            })();
          } catch (_) {}
        }
      }

      return response;
    };
  }

  markBridgeReady();
  emitTelemetry({ type: 'stream_end', activeStreams: 0, timestamp: Date.now() });
  emitTelemetry({ type: 'bridge_ready', timestamp: Date.now() });
})();
