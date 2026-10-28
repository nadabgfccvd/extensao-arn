(function () {
  'use strict';

  if (window.__AU_TEMPCHAT_BRIDGE_LOADED__) return;
  window.__AU_TEMPCHAT_BRIDGE_LOADED__ = true;

  // ARENA-18: NEVER trust URL hash (#au_room=) on its own to bind a room!
  // Room activation ONLY occurs when the authoritative Service Worker confirms
  // sender.tab.id in EXT_TAB_TO_ROOM and issues a bindingToken + bindingEpoch.
  let linkedRoomId = '';
  let bindingToken = '';
  let bindingEpoch = 0;
  let joinTargetCode = '';
  let detectedExternalCode = '';
  let autoActionDone = false;
  let sendQueue = Promise.resolve();
  const sentFingerprints = new Set();
  const seenDomMessages = new Set();

  function addBoundedSet(setObj, val, maxSize = 1000) {
    if (!val) return;
    setObj.add(val);
    if (setObj.size > maxSize) {
      const oldest = setObj.values().next().value;
      if (oldest !== undefined) setObj.delete(oldest);
    }
  }

  function normFp(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220)
      .toLowerCase();
  }

  function setNativeInputValue(el, val) {
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      if (!document.execCommand('insertText', false, val)) {
        el.textContent = val;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
      }
      return true;
    }
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const prev = el.value;
    if (desc && desc.set) desc.set.call(el, val);
    else el.value = val;
    if (el._valueTracker) {
      try {
        el._valueTracker.setValue(prev);
      } catch (_) {}
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function findChatComposerOnTempChat() {
    const candidates = Array.from(
      document.querySelectorAll(
        'textarea, input[placeholder*="message" i], input[placeholder*="type" i], input[placeholder*="chat" i], form input[type="text"], [contenteditable="true"]'
      )
    ).filter((el) => {
      if (!el.isConnected || el.disabled || el.readOnly) return false;
      if (el.maxLength === 1 || el.maxLength === 4) return false;
      if (document.hidden || window.innerWidth === 0 || window.outerWidth === 0) {
        const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
        return !st || (st.display !== 'none' && st.visibility !== 'hidden');
      }
      const r = el.getBoundingClientRect();
      return r.width >= 140 && r.height >= 24;
    });
    return candidates[candidates.length - 1] || null;
  }

  function detectFourDigitCodeOnPage() {
    const urlMatch = (location.pathname + ' ' + location.search).match(/(?:\/|=)(\d{4})(?:\b|\/|$)/);
    if (urlMatch && urlMatch[1]) return urlMatch[1];

    if (!findChatComposerOnTempChat()) return '';
    const badges = document.querySelectorAll('header, nav, h1, h2, h3, [class*="room" i], [class*="code" i], [class*="id" i], span, div');
    for (let i = 0; i < Math.min(badges.length, 120); i++) {
      const txt = (badges[i].textContent || '').trim();
      if (txt.length >= 4 && txt.length <= 36) {
        const m = txt.match(/(?:room|id|code|session|#|\b)\s*:?\s*(\d{4})\b/i);
        if (m && m[1] && !/^202\d$/.test(m[1])) {
          return m[1];
        }
      }
    }
    return '';
  }

  function tryAutoCreateOrJoinRoom() {
    if (!linkedRoomId || !bindingToken || autoActionDone) return;
    if (findChatComposerOnTempChat()) {
      autoActionDone = true;
      return;
    }

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));

    if (joinTargetCode && /^\d{4}$/.test(joinTargetCode)) {
      const otpInputs = Array.from(document.querySelectorAll('input')).filter((inp) => {
        if (inp.disabled) return false;
        if (document.hidden || window.innerWidth === 0 || window.outerWidth === 0) return true;
        const r = inp.getBoundingClientRect();
        return r.width > 16 && r.width < 120;
      });
      if (otpInputs.length >= 4) {
        for (let i = 0; i < 4; i++) {
          setNativeInputValue(otpInputs[i], joinTargetCode[i]);
        }
      } else if (otpInputs.length === 1) {
        setNativeInputValue(otpInputs[0], joinTargetCode);
      }
      const joinBtn = buttons.find((b) => /join\s+session|join\s+room|entrar/i.test((b.textContent || '').trim()));
      if (joinBtn && !joinBtn.disabled) {
        autoActionDone = true;
        joinBtn.click();
        return;
      }
    }

    const createBtn = buttons.find((b) => /create\s+session|create\s+room|start\s+chat/i.test((b.textContent || '').trim()));
    if (createBtn && !createBtn.disabled) {
      autoActionDone = true;
      createBtn.click();
    }
  }

  function isBlockedSystemPrompt(text) {
    return /(?:🤝\s*[\[*]*\s*(?:SALA TEMPCHAT|CONECTADO EM TEMPO REAL À SALA TEMPCHAT)\s*#\d+|MODO COLABORAÇÃO MULTI-AGENT|SINCRONIZAÇÃO EM TEMPO REAL\s*•\s*RODADA|SUA MISSÃO AGORA NESTA RODADA\s*:|CONVERSA EM TEMPO REAL ENTRE OS MODELOS DURANTE O TURNO|MENSAGEM AO VIVO DO COORDENADOR HUMANO NO CHAT LIVE|INTEGRAÇÃO GITHUB (?:DIRETA|PÚBLICA|ATIVA|AUTÔNOMA|SEGURA))/i.test(
      String(text || '')
    );
  }

  // SEC-08: Sanitize inbound external text so untrusted external parties cannot inject privileged commands
  function sanitizeExternalInboundText(raw) {
    return String(raw || '')
      .replace(/\[(?:GITHUB_PUSH_PRONTO|ENTREGA_FINAL_PRONTA|ATRIBUICAO_UNICA|CONTRATO_UNICO|VOTO_CONSENSO|ARQUIVO_COMPARTILHADO)[^\]]*\]/gi, '[TAG_EXTERNA_BLOQUEADA]')
      .replace(/\[AU_VAULT_REQ\][\s\S]*?\[\/AU_VAULT_REQ\]/gi, '[VAULT_REQ_EXTERNO_BLOQUEADO]')
      .trim();
  }

  function scrubOutboundText(raw) {
    return String(raw || '')
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[TOKEN_OCULTO]@')
      .replace(/(https?:\/\/)(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)@/gi, '$1[TOKEN_OCULTO]@')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[TOKEN_OCULTO]')
      .replace(/\bTEST_SECRET_DO_NOT_USE_[A-Za-z0-9_-]*\b/g, '[TOKEN_OCULTO]')
      .trim();
  }

  async function postOutboundToTempChat(text) {
    if (!linkedRoomId || !bindingToken) return false;
    const clean = scrubOutboundText(text);
    if (!clean || isBlockedSystemPrompt(clean)) return false;

    const fp = normFp(clean);
    addBoundedSet(sentFingerprints, fp);
    clean.split('\n').forEach((line) => {
      const lfp = normFp(line);
      if (lfp.length >= 6) addBoundedSet(sentFingerprints, lfp);
    });

    for (let wait = 0; wait < 25; wait++) {
      const input = findChatComposerOnTempChat();
      if (input) {
        setNativeInputValue(input, clean);
        await new Promise((r) => setTimeout(r, 90));

        const form = input.closest('form');
        const sendBtn =
          (form &&
            Array.from(form.querySelectorAll('button:not([disabled])')).find(
              (b) => b.type === 'submit' || /send|enviar/i.test((b.textContent || b.getAttribute('aria-label') || '').trim()) || b.querySelector('svg')
            )) ||
          Array.from((input.parentElement?.parentElement || document).querySelectorAll('button:not([disabled])'))
            .filter((b) => !b.closest('#au-tempchat-pill'))
            .pop();

        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
        return true;
      }
      tryAutoCreateOrJoinRoom();
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  function renderBridgeBadge() {
    let pill = document.getElementById('au-tempchat-pill');
    if (!linkedRoomId || !bindingToken) {
      if (pill) pill.remove();
      return;
    }
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'au-tempchat-pill';
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      pill.style.cssText =
        'position:fixed;left:16px;bottom:16px;z-index:2147483646;background:#111318;color:#f4f4f5;' +
        'border:1px solid #10b981;border-radius:999px;padding:7px 13px;font:600 12px/1.3 Inter,system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,0.45);display:flex;align-items:center;gap:8px;';
      document.documentElement.appendChild(pill);
    }
    const extTxt = detectedExternalCode ? ` • Código tempchat.online: #${detectedExternalCode}` : ' • Conectando sala...';
    pill.textContent = `🤝 Arena Ultra (Sala #${linkedRoomId})${extTxt}`;
  }

  function scanInboundMessages() {
    if (!linkedRoomId || !bindingToken || !findChatComposerOnTempChat()) return;
    const container = document.querySelector('main') || document.body;
    if (!container) return;

    const bubbles = container.querySelectorAll('[class*="message" i], [class*="bubble" i], [class*="chat" i] p, li p');
    for (let i = 0; i < bubbles.length; i++) {
      const el = bubbles[i];
      if (el.closest('#au-tempchat-pill') || el.closest('form')) continue;
      const raw = (el.textContent || '').trim();
      if (!raw || raw.length < 2 || raw.length > 4000) continue;
      if (/^(welcome to tempchat|create a new session|encrypted in transit|no server chat archive)/i.test(raw)) continue;

      const fp = normFp(raw);
      if (seenDomMessages.has(fp)) continue;
      addBoundedSet(seenDomMessages, fp);

      if (
        sentFingerprints.has(fp) ||
        raw.startsWith('🤖 [Agente ') ||
        raw.startsWith('👤 [Coordenador') ||
        isBlockedSystemPrompt(raw)
      ) {
        continue;
      }

      const safeText = sanitizeExternalInboundText(raw);
      if (!safeText) continue;

      try {
        chrome.runtime.sendMessage({
          type: 'AU_TEMPCHAT_INBOUND_MSG',
          roomId: linkedRoomId,
          bindingToken,
          bindingEpoch,
          externalUnverified: true,
          externalCode: detectedExternalCode,
          text: safeText
        });
      } catch (_) {}
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'AU_TEMPCHAT_UNBIND_ROOM') {
      linkedRoomId = '';
      bindingToken = '';
      bindingEpoch = 0;
      renderBridgeBadge();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'AU_TEMPCHAT_BIND_ROOM') {
      if (msg.authorized === false || !msg.roomId || !msg.bindingToken) {
        linkedRoomId = '';
        bindingToken = '';
        renderBridgeBadge();
        sendResponse({ ok: false });
        return;
      }
      linkedRoomId = String(msg.roomId);
      bindingToken = String(msg.bindingToken);
      bindingEpoch = Number(msg.bindingEpoch || 1);
      if (msg.joinCode) joinTargetCode = String(msg.joinCode).trim();
      tryAutoCreateOrJoinRoom();
      renderBridgeBadge();
      sendResponse({ ok: true, externalCode: detectedExternalCode });
      return;
    }
    if (msg.type === 'AU_TEMPCHAT_OUTBOUND_SEND') {
      if (!linkedRoomId || !bindingToken || (msg.roomId && String(msg.roomId) !== linkedRoomId)) {
        sendResponse({ ok: false, error: 'Room binding mismatch.' });
        return;
      }
      sendQueue = sendQueue
        .then(() => postOutboundToTempChat(msg.text))
        .then(() => new Promise((r) => setTimeout(r, 320)))
        .catch(() => {});
      sendResponse({ ok: true });
    }
  });

  function syncWithBackground() {
    // Ask authoritative Service Worker whether THIS tabId is registered in EXT_TAB_TO_ROOM.
    try {
      chrome.runtime.sendMessage(
        {
          type: 'AU_TEMPCHAT_BRIDGE_READY',
          externalCode: detectedExternalCode,
          url: location.href
        },
        (res) => {
          void chrome.runtime.lastError;
          if (res && res.authorized && res.roomId && res.bindingToken) {
            linkedRoomId = String(res.roomId);
            bindingToken = String(res.bindingToken);
            bindingEpoch = Number(res.bindingEpoch || 1);
            if (res.joinCode && !joinTargetCode) joinTargetCode = String(res.joinCode).trim();
            tryAutoCreateOrJoinRoom();
            renderBridgeBadge();
          } else {
            linkedRoomId = '';
            bindingToken = '';
            renderBridgeBadge();
          }
        }
      );
    } catch (_) {}
  }

  syncWithBackground();

  let scanTimer = null;
  const obs = new MutationObserver(() => {
    if (!linkedRoomId || !bindingToken || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const code = detectFourDigitCodeOnPage();
      if (code && code !== detectedExternalCode) {
        detectedExternalCode = code;
        renderBridgeBadge();
        try {
          chrome.runtime.sendMessage({
            type: 'AU_TEMPCHAT_CODE_DETECTED',
            roomId: linkedRoomId,
            bindingToken,
            bindingEpoch,
            externalCode: code
          });
        } catch (_) {}
      }
      scanInboundMessages();
    }, 320);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    if (!linkedRoomId || !bindingToken) return;
    tryAutoCreateOrJoinRoom();
    const code = detectFourDigitCodeOnPage();
    if (code && code !== detectedExternalCode) {
      detectedExternalCode = code;
      renderBridgeBadge();
      try {
        chrome.runtime.sendMessage({
          type: 'AU_TEMPCHAT_CODE_DETECTED',
          roomId: linkedRoomId,
          bindingToken,
          bindingEpoch,
          externalCode: code
        });
      } catch (_) {}
    }
  }, 1800);
})();
