(function (global) {
  'use strict';

  const SESSION_SECRETS_KEY = 'au_session_secrets_v1';
  const ENCRYPTED_VAULT_KEY = 'au_encrypted_vault_v1';
  const SECURITY_AUDIT_KEY = 'au_security_audit_log_v1';
  const PBKDF2_ITERATIONS = 100000;
  const PRIVATE_BUNDLE_MAGIC = new Uint8Array([0x41, 0x55, 0x45, 0x31]); // "AUE1" (!== "PK")
  const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_AUDIT_ENTRIES = 200;

  // Volatile RAM fallback when chrome.storage.session is unavailable (NEVER falls back to storage.local! ARENA-16)
  const RAM_SECRETS = {
    githubToken: '',
    webhookUrl: '',
    updatedAt: 0
  };
  let volatileSessionDegraded = false;

  function initStorageAccessLevels() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        if (chrome.storage.session && typeof chrome.storage.session.setAccessLevel === 'function') {
          chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
        }
        if (chrome.storage.local && typeof chrome.storage.local.setAccessLevel === 'function') {
          chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
        }
      }
    } catch (_) {}
  }
  initStorageAccessLevels();

  function getSubtleCrypto() {
    if (global.crypto && global.crypto.subtle) return global.crypto.subtle;
    throw new Error('WebCrypto API indisponível neste contexto.');
  }

  function getRandomBytes(len) {
    const out = new Uint8Array(len);
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      global.crypto.getRandomValues(out);
    } else {
      for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256);
    }
    return out;
  }

  function bytesToHex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let hex = '';
    for (let i = 0; i < u8.length; i++) {
      hex += u8[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function hexToBytes(hexStr) {
    const clean = String(hexStr || '').replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function generateRandomHex(byteLen) {
    return bytesToHex(getRandomBytes(byteLen || 32));
  }

  function bytesToBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(u8).toString('base64');
    }
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const clean = String(b64 || '').trim();
    if (!clean) return new Uint8Array(0);
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(clean, 'base64'));
    }
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Comprehensive secret scrubber (SEC-01, SEC-03, SEC-05)
  const SECRET_PATTERNS = [
    /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
    /\bglpat-[A-Za-z0-9_-]{16,128}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{16,128}\b/g,
    /\bTEST_SECRET_DO_NOT_USE_[A-Za-z0-9_]*\b/g,
    /(https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/gi,
    /(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/gi,
    /(https:\/\/api\.telegram\.org\/bot\d+:)[A-Za-z0-9_-]+/gi,
    /(https?:\/\/[^/\s:@]+:)(?:ghp_|github_pat_|gho_|ghu_|ghs_|glpat-)[^@\s]+@/gi
  ];

  const KNOWN_DYNAMIC_SECRETS = new Set();

  function registerKnownSecret(secretStr) {
    const s = String(secretStr || '').trim();
    if (s.length >= 8) {
      KNOWN_DYNAMIC_SECRETS.add(s);
    }
  }

  function scrubTextSecrets(input, extraLiterals) {
    if (input === null || input === undefined) return '';
    let out = String(input);
    if (RAM_SECRETS.githubToken && RAM_SECRETS.githubToken.length >= 8) {
      out = out.split(RAM_SECRETS.githubToken).join('[REDACTED_SECRET]');
    }
    if (RAM_SECRETS.webhookUrl && RAM_SECRETS.webhookUrl.length >= 12) {
      out = out.split(RAM_SECRETS.webhookUrl).join('[REDACTED_WEBHOOK]');
    }
    for (const dyn of KNOWN_DYNAMIC_SECRETS) {
      if (dyn && dyn.length >= 8) {
        out = out.split(dyn).join('[REDACTED_SECRET]');
      }
    }
    const extras = Array.isArray(extraLiterals)
      ? extraLiterals
      : typeof extraLiterals === 'string' && extraLiterals.trim()
        ? [extraLiterals]
        : [];
    for (let i = 0; i < extras.length; i++) {
      const lit = String(extras[i] || '').trim();
      if (lit.length >= 8) {
        out = out.split(lit).join('[REDACTED_SECRET]');
      }
    }
    out = out
      .replace(SECRET_PATTERNS[0], '[REDACTED_GH_TOKEN]')
      .replace(SECRET_PATTERNS[1], '[REDACTED_GH_PAT]')
      .replace(SECRET_PATTERNS[2], '[REDACTED_GITLAB_PAT]')
      .replace(SECRET_PATTERNS[3], '[REDACTED_SLACK_TOKEN]')
      .replace(SECRET_PATTERNS[4], '[REDACTED_SENTINEL_SECRET]')
      .replace(SECRET_PATTERNS[5], '$1[REDACTED_WEBHOOK]')
      .replace(SECRET_PATTERNS[6], '$1[REDACTED_WEBHOOK]')
      .replace(SECRET_PATTERNS[7], '$1[REDACTED_BOT_TOKEN]')
      .replace(SECRET_PATTERNS[8], '$1[REDACTED_TOKEN]@');
    return out;
  }

  function containsAnySecret(input, extraLiterals) {
    const raw = String(input || '');
    if (!raw) return false;
    return scrubTextSecrets(raw, extraLiterals) !== raw;
  }

  async function deriveAesGcmKey(passphrase, saltBytes, usages) {
    const subtle = getSubtleCrypto();
    const enc = new TextEncoder();
    const baseKey = await subtle.importKey(
      'raw',
      enc.encode(String(passphrase || '')),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages || ['encrypt', 'decrypt']
    );
  }

  async function encryptJsonWithPassphrase(payloadObj, passphrase) {
    if (!passphrase || String(passphrase).length < 6) {
      throw new Error('A senha de cifragem do cofre deve ter ao menos 6 caracteres.');
    }
    const subtle = getSubtleCrypto();
    const salt = getRandomBytes(16);
    const iv = getRandomBytes(12);
    const key = await deriveAesGcmKey(passphrase, salt, ['encrypt']);
    const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj || {}));
    const cipherBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return {
      v: 1,
      alg: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iter: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(cipherBuf)),
      savedAt: Date.now()
    };
  }

  async function decryptJsonWithPassphrase(envelope, passphrase) {
    if (!envelope || envelope.alg !== 'AES-256-GCM' || !envelope.ct) {
      throw new Error('Envelope cifrado inválido.');
    }
    const subtle = getSubtleCrypto();
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ct = base64ToBytes(envelope.ct);
    const key = await deriveAesGcmKey(passphrase, salt, ['decrypt']);
    try {
      const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      const jsonStr = new TextDecoder('utf-8').decode(plainBuf);
      return JSON.parse(jsonStr);
    } catch (_) {
      throw new Error('Senha incorreta ou cofre cifrado corrompido.');
    }
  }

  // SEC-06: Encrypt/Decrypt binary bundles (magic header "AUE1" !== "PK")
  async function encryptPrivateBinary(rawBytes, secretKeyStr) {
    if (!secretKeyStr || String(secretKeyStr).length < 12) {
      throw new Error('Chave efêmera insuficiente para cifrar artefato privado.');
    }
    const subtle = getSubtleCrypto();
    const input = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes || 0);
    const salt = getRandomBytes(16);
    const iv = getRandomBytes(12);
    const key = await deriveAesGcmKey(secretKeyStr, salt, ['encrypt']);
    const cipherBuf = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, input));
    const out = new Uint8Array(4 + 16 + 12 + cipherBuf.length);
    out.set(PRIVATE_BUNDLE_MAGIC, 0);
    out.set(salt, 4);
    out.set(iv, 20);
    out.set(cipherBuf, 32);
    return out;
  }

  async function decryptPrivateBinary(encBytes, secretKeyStr) {
    const input = encBytes instanceof Uint8Array ? encBytes : new Uint8Array(encBytes || 0);
    if (
      input.length < 48 ||
      input[0] !== 0x41 ||
      input[1] !== 0x55 ||
      input[2] !== 0x45 ||
      input[3] !== 0x31
    ) {
      throw new Error('Formato de artefato cifrado inválido (magic header AUE1 ausente).');
    }
    const subtle = getSubtleCrypto();
    const salt = input.subarray(4, 20);
    const iv = input.subarray(20, 32);
    const ct = input.subarray(32);
    const key = await deriveAesGcmKey(secretKeyStr, salt, ['decrypt']);
    const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new Uint8Array(plainBuf);
  }

  // SEC-08: Per-Room HMAC-SHA256 Signing & Verification
  function buildCanonicalMessageString(msg) {
    if (!msg || typeof msg !== 'object') return '';
    return [
      String(msg.roomId || ''),
      String(msg.seq !== undefined ? msg.seq : ''),
      String(msg.id || ''),
      String(msg.senderTag || msg.author || ''),
      String(msg.ts || msg.timestamp || ''),
      String(msg.text || '')
    ].join('\n');
  }

  async function signRoomMessageHmac(roomKeyHex, msgOrString) {
    if (!roomKeyHex) return '';
    const subtle = getSubtleCrypto();
    const keyBytes = hexToBytes(roomKeyHex);
    if (!keyBytes.length) return '';
    const cryptoKey = await subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const canonical = typeof msgOrString === 'string' ? msgOrString : buildCanonicalMessageString(msgOrString);
    const sigBuf = await subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(canonical));
    return bytesToHex(new Uint8Array(sigBuf));
  }

  async function verifyRoomMessageHmac(roomKeyHex, msgOrString, signatureHex) {
    if (!roomKeyHex || !signatureHex) return false;
    const expected = await signRoomMessageHmac(roomKeyHex, msgOrString);
    if (!expected || expected.length !== String(signatureHex).length) return false;
    // Constant-time string comparison
    let diff = 0;
    const sig = String(signatureHex).toLowerCase();
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return diff === 0;
  }

  // SEC-02 & ARENA-16: Volatile Session Secret Storage (NEVER falls back to chrome.storage.local!)
  function hasChromeSessionStorage() {
    return Boolean(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session);
  }

  async function getSessionSecrets() {
    if (!hasChromeSessionStorage()) {
      volatileSessionDegraded = true;
      return Object.assign({}, RAM_SECRETS, { volatileDegraded: true });
    }
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(SESSION_SECRETS_KEY, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            volatileSessionDegraded = true;
            resolve(Object.assign({}, RAM_SECRETS, { volatileDegraded: true }));
            return;
          }
          const saved = (res && res[SESSION_SECRETS_KEY]) || {};
          if (saved.githubToken) RAM_SECRETS.githubToken = saved.githubToken;
          if (saved.webhookUrl) RAM_SECRETS.webhookUrl = saved.webhookUrl;
          resolve({
            githubToken: saved.githubToken || RAM_SECRETS.githubToken || '',
            webhookUrl: saved.webhookUrl || RAM_SECRETS.webhookUrl || '',
            updatedAt: saved.updatedAt || RAM_SECRETS.updatedAt || 0,
            volatileDegraded: false
          });
        });
      } catch (_) {
        volatileSessionDegraded = true;
        resolve(Object.assign({}, RAM_SECRETS, { volatileDegraded: true }));
      }
    });
  }

  async function setSessionSecrets(partial) {
    const cur = await getSessionSecrets();
    const next = {
      githubToken: partial.githubToken !== undefined ? String(partial.githubToken || '').trim() : cur.githubToken,
      webhookUrl: partial.webhookUrl !== undefined ? String(partial.webhookUrl || '').trim() : cur.webhookUrl,
      updatedAt: Date.now()
    };
    RAM_SECRETS.githubToken = next.githubToken;
    RAM_SECRETS.webhookUrl = next.webhookUrl;
    RAM_SECRETS.updatedAt = next.updatedAt;

    if (!hasChromeSessionStorage()) {
      volatileSessionDegraded = true;
      return Object.assign({}, next, { volatileDegraded: true });
    }
    return new Promise((resolve) => {
      try {
        chrome.storage.session.set({ [SESSION_SECRETS_KEY]: next }, () => {
          resolve(Object.assign({}, next, { volatileDegraded: false }));
        });
      } catch (_) {
        volatileSessionDegraded = true;
        resolve(Object.assign({}, next, { volatileDegraded: true }));
      }
    });
  }

  async function clearAllSecrets() {
    RAM_SECRETS.githubToken = '';
    RAM_SECRETS.webhookUrl = '';
    RAM_SECRETS.updatedAt = Date.now();
    if (hasChromeSessionStorage()) {
      await new Promise((r) => chrome.storage.session.remove(SESSION_SECRETS_KEY, () => r()));
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise((r) => chrome.storage.local.remove(ENCRYPTED_VAULT_KEY, () => r()));
    }
    return true;
  }

  async function saveEncryptedVaultToDisk(secretsObj, passphrase) {
    const env = await encryptJsonWithPassphrase(
      {
        githubToken: String((secretsObj && secretsObj.githubToken) || '').trim(),
        webhookUrl: String((secretsObj && secretsObj.webhookUrl) || '').trim()
      },
      passphrase
    );
    await setSessionSecrets(secretsObj || {});
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise((r) => chrome.storage.local.set({ [ENCRYPTED_VAULT_KEY]: env }, () => r()));
    }
    return { ok: true, savedAt: env.savedAt };
  }

  async function unlockEncryptedVaultFromDisk(passphrase) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      throw new Error('Armazenamento local indisponível.');
    }
    const res = await new Promise((r) => chrome.storage.local.get(ENCRYPTED_VAULT_KEY, (x) => r(x || {})));
    if (!res[ENCRYPTED_VAULT_KEY]) {
      throw new Error('Nenhum cofre cifrado encontrado em disco.');
    }
    const unlocked = await decryptJsonWithPassphrase(res[ENCRYPTED_VAULT_KEY], passphrase);
    await setSessionSecrets(unlocked);
    return {
      ok: true,
      hasGithubToken: Boolean(unlocked.githubToken),
      hasWebhookUrl: Boolean(unlocked.webhookUrl)
    };
  }

  async function hasEncryptedVaultOnDisk() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return false;
    const res = await new Promise((r) => chrome.storage.local.get(ENCRYPTED_VAULT_KEY, (x) => r(x || {})));
    return Boolean(res && res[ENCRYPTED_VAULT_KEY] && res[ENCRYPTED_VAULT_KEY].ct);
  }

  // SEC-05: Sanitized Security & API Audit Ring Buffer (30 days, max 200 items, zero secrets)
  let auditWriteChain = Promise.resolve();
  async function getSecurityAuditLog() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return [];
    const res = await new Promise((r) => chrome.storage.local.get(SECURITY_AUDIT_KEY, (x) => r(x || {})));
    const list = Array.isArray(res[SECURITY_AUDIT_KEY]) ? res[SECURITY_AUDIT_KEY] : [];
    const cutoff = Date.now() - AUDIT_RETENTION_MS;
    return list.filter((it) => it && Number(it.ts || 0) >= cutoff);
  }

  function recordSecurityAudit(entry) {
    const op = auditWriteChain.then(async () => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      const current = await getSecurityAuditLog();
      const safeItem = {
        id: 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        category: scrubTextSecrets(entry && entry.category ? entry.category : 'github_api').slice(0, 40),
        action: scrubTextSecrets(entry && entry.action ? entry.action : '').slice(0, 80),
        endpoint: scrubTextSecrets(entry && entry.endpoint ? entry.endpoint : '').slice(0, 180),
        repo: scrubTextSecrets(entry && entry.repo ? entry.repo : '').slice(0, 100),
        roomId: entry && entry.roomId ? String(entry.roomId).slice(0, 32) : '',
        agentTag: entry && entry.agentTag ? String(entry.agentTag).slice(0, 40) : '',
        status: entry && entry.status !== undefined ? String(entry.status).slice(0, 32) : 'ok',
        detail: scrubTextSecrets(entry && entry.detail ? entry.detail : '').slice(0, 220)
      };
      const next = [safeItem].concat(current).slice(0, MAX_AUDIT_ENTRIES);
      await new Promise((r) => chrome.storage.local.set({ [SECURITY_AUDIT_KEY]: next }, () => r()));
    });
    auditWriteChain = op.catch(() => {});
    return op;
  }

  async function setSessionSecret(kind, val) {
    const clean = String(val || '').trim();
    if (clean) registerKnownSecret(clean);
    if (kind === 'github_pat' || kind === 'githubToken') {
      const r = await setSessionSecrets({ githubToken: clean });
      return { ok: true, sessionUnavailable: Boolean(r.volatileDegraded) };
    }
    if (kind === 'webhook_url' || kind === 'webhookUrl') {
      const r = await setSessionSecrets({ webhookUrl: clean });
      return { ok: true, sessionUnavailable: Boolean(r.volatileDegraded) };
    }
    return { ok: false, sessionUnavailable: volatileSessionDegraded };
  }

  async function getSessionSecret(kind) {
    const r = await getSessionSecrets();
    if (kind === 'github_pat' || kind === 'githubToken') {
      return { value: r.githubToken || '', sessionUnavailable: Boolean(r.volatileDegraded) };
    }
    if (kind === 'webhook_url' || kind === 'webhookUrl') {
      return { value: r.webhookUrl || '', sessionUnavailable: Boolean(r.volatileDegraded) };
    }
    return { value: '', sessionUnavailable: Boolean(r.volatileDegraded) };
  }

  async function clearSessionSecret(kind) {
    if (kind === 'github_pat' || kind === 'githubToken') {
      return setSessionSecrets({ githubToken: '' });
    }
    if (kind === 'webhook_url' || kind === 'webhookUrl') {
      return setSessionSecrets({ webhookUrl: '' });
    }
    return clearAllSecrets();
  }

  async function clearEncryptedSecret() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise((r) => chrome.storage.local.remove(ENCRYPTED_VAULT_KEY, () => r()));
    }
    return true;
  }

  async function signRoomMessage(roomKeyHex, roomId, tagOrAuthor, ts, text, msgId) {
    const idVal = String(msgId || '');
    return signRoomMessageHmac(roomKeyHex, {
      roomId: String(roomId || ''),
      seq: idVal,
      id: idVal,
      senderTag: String(tagOrAuthor || ''),
      ts: String(ts !== undefined ? ts : ''),
      text: String(text || '')
    });
  }

  async function verifyRoomMessage(roomKeyHex, roomId, tagOrAuthor, ts, text, signatureHex, msgId) {
    const idVal = String(msgId || '');
    return verifyRoomMessageHmac(
      roomKeyHex,
      {
        roomId: String(roomId || ''),
        seq: idVal,
        id: idVal,
        senderTag: String(tagOrAuthor || ''),
        ts: String(ts !== undefined ? ts : ''),
        text: String(text || '')
      },
      signatureHex
    );
  }

  global.AU_CRED_BROKER = {
    SESSION_SECRETS_KEY,
    ENCRYPTED_VAULT_KEY,
    SECURITY_AUDIT_KEY,
    PRIVATE_BUNDLE_MAGIC,
    generateRandomHex,
    generateRoomHmacKeyHex: () => generateRandomHex(32),
    bytesToHex,
    hexToBytes,
    bytesToBase64,
    base64ToBytes,
    registerKnownSecret,
    scrubTextSecrets,
    scrubSecrets: scrubTextSecrets,
    containsAnySecret,
    containsSecret: (input) => {
      if (containsAnySecret(input)) return true;
      const s = String(input || '');
      for (const dyn of KNOWN_DYNAMIC_SECRETS) {
        if (dyn && dyn.length >= 8 && s.includes(dyn)) return true;
      }
      return false;
    },
    encryptJsonWithPassphrase,
    decryptJsonWithPassphrase,
    encryptPrivateBinary,
    decryptPrivateBinary,
    encryptBinaryBundle: encryptPrivateBinary,
    decryptBinaryBundle: decryptPrivateBinary,
    buildCanonicalMessageString,
    signRoomMessageHmac,
    verifyRoomMessageHmac,
    signRoomMessage,
    verifyRoomMessage,
    getSessionSecrets,
    setSessionSecrets,
    getSessionSecret,
    setSessionSecret,
    clearSessionSecret,
    clearEncryptedSecret,
    clearAllSecrets,
    saveEncryptedVaultToDisk,
    unlockEncryptedVaultFromDisk,
    hasEncryptedVaultOnDisk,
    getSecurityAuditLog,
    recordSecurityAudit,
    appendSecurityAuditLog: recordSecurityAudit,
    isVolatileDegraded: () => volatileSessionDegraded
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
