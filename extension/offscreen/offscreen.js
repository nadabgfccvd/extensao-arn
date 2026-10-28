(function () {
  'use strict';

  function sendKeepAliveTick() {
    try {
      chrome.runtime.sendMessage({ type: 'AU_OFFSCREEN_TICK', ts: Date.now() }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  // Dedicated Worker inside Offscreen Document is immune to Windows Lock Screen & Window Occlusion throttling!
  let fallbackTimer = null;
  function ensureFallbackTimer() {
    if (!fallbackTimer) {
      fallbackTimer = setInterval(sendKeepAliveTick, 1800);
    }
  }
  try {
    const worker = new Worker('offscreen-worker.js');
    worker.onmessage = () => {
      sendKeepAliveTick();
    };
    worker.onerror = () => {
      ensureFallbackTimer();
    };
  } catch (_) {
    ensureFallbackTimer();
  }

  sendKeepAliveTick();
})();
