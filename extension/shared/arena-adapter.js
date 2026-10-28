(function (global) {
  'use strict';

  const ALLOWED_ARENA_HOSTS_RX = /^(?:[a-z0-9-]+\.)?(?:arena\.ai|lmarena\.ai)$/i;

  function isAllowedArenaOrigin(originOrUrl) {
    if (!originOrUrl) return false;
    try {
      const u = new URL(String(originOrUrl));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      return ALLOWED_ARENA_HOSTS_RX.test(u.hostname || '');
    } catch (_) {
      return false;
    }
  }

  function getConversationIdentity(rawUrl, tabId) {
    const str = String(rawUrl || '');
    let pathname = '/';
    let searchId = '';
    let origin = 'https://arena.ai';
    try {
      const u = new URL(str);
      pathname = u.pathname || '/';
      origin = u.origin || origin;
      searchId = u.searchParams.get('id') || u.searchParams.get('chatId') || '';
    } catch (_) {}

    let mode = 'chat';
    if (/\/agent(\/|$)/i.test(pathname)) mode = 'agent';
    else if (/\/battle(\/|$)/i.test(pathname)) mode = 'battle';

    let conversationId = null;
    const pathMatch =
      pathname.match(/\/(?:agent|c|chat|battle)\/([A-Za-z0-9_-]{6,128})/i) ||
      pathname.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (pathMatch && pathMatch[1]) {
      conversationId = pathMatch[1];
    } else if (searchId && /^[A-Za-z0-9_-]{6,128}$/.test(searchId)) {
      conversationId = searchId;
    }

    const isGenericRoot = !conversationId && /^\/(?:agent|battle|chat)?\/?$/i.test(pathname);
    return {
      conversationId,
      mode,
      isGenericRoot,
      tabId: tabId !== undefined ? tabId : null,
      origin,
      pathname,
      url: str
    };
  }

  // Returns true ONLY when the user genuinely switched to a DIFFERENT conversation
  // (NOT when a brand-new `/agent` tab acquires its `/agent/<uuid>` on Turn 1!)
  function didSwitchConversation(prevIdentity, nextIdentity) {
    if (!prevIdentity || !nextIdentity) return false;
    const prevId = prevIdentity.conversationId;
    const nextId = nextIdentity.conversationId;
    if (prevId && nextId && prevId !== nextId) return true;
    // Switched from an established conversation back to blank `/agent` (“New Chat”)
    if (prevId && !nextId && nextIdentity.isGenericRoot) return true;
    return false;
  }

  // ARENA-02: Strip <details>, <thought>, hidden & sr-only nodes before extracting assistant text
  const IGNORED_TURN_SELECTORS = [
    'details',
    'think',
    'thought',
    'script',
    'style',
    'noscript',
    'template',
    '[hidden]',
    '[aria-hidden="true"]',
    '.sr-only',
    '[data-reasoning]',
    '[data-thinking]',
    '[data-testid*="reasoning"]',
    '[data-testid*="thinking"]',
    '[class*="reasoning-block"]',
    '[class*="thought-block"]',
    '[id^="arena-ultra"]'
  ].join(', ');

  function extractCleanTurnText(el) {
    if (!el) return { text: '', strippedCount: 0 };
    let strippedCount = 0;
    let rawText = '';
    try {
      const clone = el.cloneNode(true);
      if (clone && typeof clone.querySelectorAll === 'function') {
        const unwanted = clone.querySelectorAll(IGNORED_TURN_SELECTORS);
        strippedCount += unwanted.length;
        for (let i = 0; i < unwanted.length; i++) {
          if (unwanted[i] && unwanted[i].parentNode) {
            unwanted[i].parentNode.removeChild(unwanted[i]);
          }
        }
      }
      rawText = (clone && (clone.innerText || clone.textContent)) || '';
    } catch (_) {
      rawText = el.innerText || el.textContent || '';
    }

    // Text-level defense-in-depth scrubbing for serialized <thought> / <details> blocks
    const scrubbed = scrubSerializedReasoning(rawText);
    return {
      text: scrubbed.text,
      strippedCount: strippedCount + scrubbed.strippedBlocks
    };
  }

  function scrubSerializedReasoning(input) {
    if (!input) return { text: '', strippedBlocks: 0 };
    let strippedBlocks = 0;
    let out = String(input);
    const patterns = [
      /<details\b[^>]*>[\s\S]*?<\/details>/gi,
      /<(?:think|thought|antThinking)\b[^>]*>[\s\S]*?<\/(?:think|thought|antThinking)>/gi,
      /<arena-system-message>[\s\S]*?<\/arena-system-message>/gi
    ];
    for (let i = 0; i < patterns.length; i++) {
      out = out.replace(patterns[i], () => {
        strippedBlocks++;
        return '';
      });
    }
    return {
      text: out.replace(/\n{4,}/g, '\n\n\n').trim(),
      strippedBlocks
    };
  }

  // ARENA-04: Detect interactive human-in-the-loop cards (ask_user, add_voice, generate_image offer_options, connectors)
  function isNodeVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    if (el.closest && el.closest('#arena-ultra-root, header, nav, [data-sidebar="sidebar"]')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 4 || rect.height <= 4) return false;
    if (typeof global.getComputedStyle === 'function') {
      const st = global.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    }
    return true;
  }

  function findPendingHumanInteraction(doc) {
    const root = doc || (typeof document !== 'undefined' ? document : null);
    if (!root || typeof root.querySelectorAll !== 'function') {
      return { pending: false, kind: null, summary: '' };
    }
    const main = root.querySelector('main') || root.body;
    if (!main) return { pending: false, kind: null, summary: '' };

    // 1. Explicit data-tool / aria markers or interactive cards at the bottom of the conversation
    const candidates = main.querySelectorAll(
      '[data-tool-name], [data-testid*="ask-user"], [data-testid*="ask_user"], [data-testid*="voice-audition"], [data-testid*="image-options"], [role="radiogroup"], fieldset, section, div[class*="rounded-"]'
    );

    // Inspect only recent bottom-most interactive widgets to avoid matching completed historical cards
    const startIdx = Math.max(0, candidates.length - 45);
    for (let i = candidates.length - 1; i >= startIdx; i--) {
      const card = candidates[i];
      if (!isNodeVisible(card)) continue;
      const toolAttr = String(card.getAttribute('data-tool-name') || card.getAttribute('data-testid') || '').toLowerCase();
      const text = String(card.innerText || card.textContent || '').trim();
      if (!text || text.length > 3200) continue;

      // Ignore already-submitted / answered historical cards
      if (/\b(answered|submitted|selected|respondido|selecionado|enviado)\b/i.test(card.getAttribute('data-state') || '')) {
        continue;
      }
      const activeBtns = Array.from(card.querySelectorAll('button:not([disabled]), [role="radio"]:not([aria-disabled="true"])')).filter(isNodeVisible);
      if (activeBtns.length === 0) continue;

      // (a) ask_user multi-option clarifying question card
      if (
        toolAttr.includes('ask_user') ||
        toolAttr.includes('ask-user') ||
        (card.querySelectorAll('[role="radio"]:not([disabled]), input[type="radio"]:not([disabled])').length >= 2) ||
        (activeBtns.length >= 2 &&
          /\b(submit|confirm|send answer|skip|other|custom response|enviar resposta|confirmar escolha)\b/i.test(text) &&
          /\?/.test(text))
      ) {
        return {
          pending: true,
          kind: 'ask_user',
          summary: text.split('\n')[0].slice(0, 140) || 'Pergunta interativa ask_user aguardando escolha'
        };
      }

      // (b) add_voice side-by-side voice audition card
      if (
        toolAttr.includes('add_voice') ||
        toolAttr.includes('voice') ||
        (card.querySelectorAll('audio').length >= 2 && activeBtns.length >= 2) ||
        (/\b(choose a voice|pick a voice|select voice|voice a\b|voice b\b|escolha uma voz|ouvir voz)\b/i.test(text) && activeBtns.length >= 2)
      ) {
        return {
          pending: true,
          kind: 'add_voice',
          summary: 'Audição de voz (add_voice) aguardando votação do usuário'
        };
      }

      // (c) generate_image offer_options candidate picker
      if (
        toolAttr.includes('image-options') ||
        toolAttr.includes('offer_options') ||
        (card.querySelectorAll('img').length >= 2 &&
          activeBtns.length >= 2 &&
          /\b(prefer|choose|pick|select|option 1|option 2|candidate|escolha a imagem|preferida)\b/i.test(text))
      ) {
        return {
          pending: true,
          kind: 'image_options',
          summary: 'Seleção de imagem candidata (offer_options) aguardando escolha'
        };
      }

      // (d) App Connector enable/connect card
      if (
        activeBtns.length >= 1 &&
        /\b(connect app|enable connector|connect to (?:notion|slack|github|linear|google)|conectar (?:notion|slack|github)|ativar conector)\b/i.test(text)
      ) {
        return {
          pending: true,
          kind: 'connector_auth',
          summary: 'Autorização de aplicativo conectado aguardando ação humana'
        };
      }
    }

    return { pending: false, kind: null, summary: '' };
  }

  // ARENA-09 (§9.4): Granular Capability Detection & Generation State Observation
  function detectCapabilities(doc, rawUrl) {
    const root = doc || (typeof document !== 'undefined' ? document : null);
    const id = getConversationIdentity(rawUrl || (global.location ? global.location.href : ''));
    if (!root) {
      return {
        version: 'UNKNOWN',
        capabilities: {
          editor: false,
          sendButton: false,
          stopButton: false,
          taskReview: false,
          humanCards: true,
          workspaceCas: Boolean(id.conversationId)
        },
        evidence: ['no_document']
      };
    }

    const hasTiptap = Boolean(root.querySelector('.ProseMirror[contenteditable="true"], .tiptap[contenteditable="true"]'));
    const hasTextarea = Boolean(root.querySelector('textarea:not([disabled])'));
    const hasSend = Boolean(
      root.querySelector('button[type="submit"], button[aria-label*="Send" i], button[aria-label*="Enviar" i]')
    );
    const hasStop = Boolean(
      root.querySelector('button[aria-label*="Stop" i], button[title*="Stop" i], button[aria-label*="Parar" i]')
    );

    const evidence = [];
    if (hasTiptap) evidence.push('tiptap_prosemirror');
    if (hasTextarea) evidence.push('textarea_fallback');
    if (hasSend) evidence.push('send_button');
    if (id.conversationId) evidence.push('workspace_cas_id');

    return {
      version: hasTiptap ? 'arena-tiptap-2026' : hasTextarea ? 'arena-textarea-fallback' : 'UNKNOWN',
      capabilities: {
        editor: hasTiptap || hasTextarea,
        sendButton: hasSend,
        stopButton: hasStop,
        taskReview: true,
        humanCards: true,
        workspaceCas: Boolean(id.conversationId && id.mode === 'agent')
      },
      evidence
    };
  }

  function observeGeneration(doc, hints) {
    const h = hints || {};
    const now = Date.now();
    const human = findPendingHumanInteraction(doc);
    if (human.pending) {
      return {
        state: 'WAITING_USER',
        pendingInteraction: human,
        evidence: ['human_card:' + human.kind],
        observedAt: now
      };
    }
    if (h.securityPaused) {
      return { state: 'WAITING_USER', evidence: ['security_verification'], observedAt: now };
    }
    if (h.tokenLimitError || h.sessionError) {
      return { state: 'ERROR', evidence: [h.tokenLimitError ? 'token_limit' : 'session_error'], observedAt: now };
    }
    if (h.isGenerating) {
      return { state: 'GENERATING', evidence: ['active_stream_or_stop_btn'], observedAt: now };
    }
    if (h.isSubmitting) {
      return { state: 'SUBMITTING', evidence: ['pending_submit_op'], observedAt: now };
    }
    const caps = detectCapabilities(doc);
    if (!caps.capabilities.editor && !h.hasAssistantTurns) {
      return { state: 'UNKNOWN', evidence: ['editor_unavailable'], observedAt: now };
    }
    return {
      state: h.hasAssistantTurns ? 'COMPLETED' : 'IDLE',
      evidence: [h.hasAssistantTurns ? 'idle_after_turn' : 'idle_ready'],
      observedAt: now
    };
  }

  global.AU_ARENA_ADAPTER = {
    isAllowedArenaOrigin,
    getConversationIdentity,
    didSwitchConversation,
    extractCleanTurnText,
    scrubSerializedReasoning,
    findPendingHumanInteraction,
    detectCapabilities,
    observeGeneration
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
