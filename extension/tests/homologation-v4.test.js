'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, '..');

function createChromeMock(opts = {}) {
  const localStore = {};
  const sessionStore = {};
  const messageListeners = [];
  const alarmListeners = [];
  const alarms = new Map();
  let nextTabId = 100;
  const openTabs = new Map();

  const withCb = (promise, cb) => {
    if (typeof cb === 'function') {
      promise.then((res) => cb(res));
    }
    return promise;
  };

  const makeArea = (store, disabled = false) =>
    disabled
      ? undefined
      : {
          get(keys, cb) {
            const p = (async () => {
              if (!keys || typeof keys === 'function') return { ...store };
              if (typeof keys === 'string') return { [keys]: store[keys] };
              if (Array.isArray(keys)) {
                const out = {};
                for (const k of keys) {
                  if (store[k] !== undefined) out[k] = store[k];
                }
                return out;
              }
              const out = { ...keys };
              for (const k of Object.keys(keys)) {
                if (store[k] !== undefined) out[k] = store[k];
              }
              return out;
            })();
            return withCb(p, typeof keys === 'function' ? keys : cb);
          },
          set(patch, cb) {
            const p = (async () => {
              for (const [k, v] of Object.entries(patch || {})) {
                store[k] = JSON.parse(JSON.stringify(v));
              }
            })();
            return withCb(p, cb);
          },
          remove(keys, cb) {
            const p = (async () => {
              const arr = Array.isArray(keys) ? keys : [keys];
              for (const k of arr) delete store[k];
            })();
            return withCb(p, cb);
          }
        };

  const chrome = {
    _localStore: localStore,
    _sessionStore: sessionStore,
    _openTabs: openTabs,
    _alarms: alarms,
    _sentTabMessages: [],
    _dispatchMessage(msg, sender = {}) {
      return new Promise((resolve) => {
        let handledAsync = false;
        for (const fn of messageListeners) {
          const ret = fn(msg, sender, (resp) => resolve(resp));
          if (ret === true) handledAsync = true;
        }
        if (!handledAsync) resolve(undefined);
      });
    },
    runtime: {
      id: 'arena-ultra-test-ext',
      getManifest: () => ({ version: '4.1.0' }),
      getURL: (p) => `chrome-extension://arena-ultra-test-ext/${String(p).replace(/^\//, '')}`,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onConnect: { addListener() {} },
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        }
      },
      sendMessage: (_m, cb) => withCb(Promise.resolve({ ok: true }), cb)
    },
    storage: {
      local: makeArea(localStore, false),
      session: makeArea(sessionStore, Boolean(opts.disableSessionStorage)),
      onChanged: { addListener() {} }
    },
    alarms: {
      create(name, info) {
        alarms.set(name, info);
      },
      clear: (name, cb) => withCb(Promise.resolve(alarms.delete(name)), cb),
      getAll: (cb) => withCb(Promise.resolve([...alarms.entries()].map(([name, info]) => ({ name, ...info }))), cb),
      onAlarm: {
        addListener(fn) {
          alarmListeners.push(fn);
        }
      }
    },
    action: {
      setBadgeText: (_d, cb) => withCb(Promise.resolve(), cb),
      setBadgeBackgroundColor: (_d, cb) => withCb(Promise.resolve(), cb)
    },
    notifications: {
      create: (_id, _opts, cb) => cb && cb()
    },
    permissions: {
      contains: (_p, cb) => withCb(Promise.resolve(true), cb),
      request: (_p, cb) => withCb(Promise.resolve(true), cb)
    },
    scripting: {
      executeScript: (_o, cb) => withCb(Promise.resolve([{ result: { ok: true } }]), cb)
    },
    tabs: {
      query: (_q, cb) => withCb(Promise.resolve([...openTabs.values()]), cb),
      get: (id, cb) =>
        withCb(
          Promise.resolve(openTabs.get(id) || { id, url: 'https://arena.ai/agent', title: 'Arena Agent', windowId: 1 }),
          cb
        ),
      create: (props = {}, cb) => {
        const id = ++nextTabId;
        const tab = { id, url: props.url || 'https://arena.ai/agent', active: Boolean(props.active), windowId: 1 };
        openTabs.set(id, tab);
        return withCb(Promise.resolve(tab), cb);
      },
      update: (id, patch = {}, cb) => {
        const cur = openTabs.get(id) || { id, windowId: 1 };
        Object.assign(cur, patch);
        openTabs.set(id, cur);
        return withCb(Promise.resolve(cur), cb);
      },
      sendMessage: (_id, _msg, cb) => {
        chrome._sentTabMessages.push({ tabId: _id, msg: _msg });
        return withCb(Promise.resolve({ ok: true }), cb);
      },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      onReplaced: { addListener() {} }
    }
  };
  return chrome;
}

function loadSharedContext(opts = {}) {
  const chrome = createChromeMock(opts);
  const ctx = {
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Blob,
    FormData,
    Headers,
    Response,
    Request,
    AbortController,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: opts.fetch || (async () => new Response('{}', { status: 200 })),
    chrome
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  const sharedFiles = [
    'i18n.js',
    'cred-broker.js',
    'diff-engine.js',
    'arena-adapter.js',
    'scheduler.js',
    'plugin-runtime.js',
    'defaults.js',
    'storage.js',
    'integrations.js',
    'agent-kit.js',
    'harness-engine.js',
    'collab-engine.js'
  ];
  for (const f of sharedFiles) {
    const code = fs.readFileSync(path.join(ROOT, 'shared', f), 'utf8');
    vm.runInContext(code, ctx, { filename: `shared/${f}` });
  }
  if (opts.loadServiceWorker) {
    ctx.importScripts = () => {};
    const swCode = fs.readFileSync(path.join(ROOT, 'background', 'service-worker.js'), 'utf8');
    vm.runInContext(swCode, ctx, { filename: 'background/service-worker.js' });
  }
  return { ctx, chrome };
}

function extractHeredocScript(shellBlock, targetPath) {
  const escaped = targetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`cat << '([A-Z0-9_]+)' > ${escaped}\\n([\\s\\S]*?)\\n\\1`);
  const m = String(shellBlock || '').match(re);
  if (!m) throw new Error(`Could not extract heredoc for ${targetPath}`);
  return m[2];
}

// ============================================================================
// A01 — SEC-01: Zero Secrets in Prompts, Terminal Scripts, Logs & Exports
// ============================================================================
test('A01 (SEC-01): Sentinel PAT never leaks into generated prompts, CLI scripts, or scrubbed text', () => {
  const { ctx } = loadSharedContext();
  const SENTINEL = 'ghp_TEST_SECRET_DO_NOT_USE_1234567890ABCDEF';
  ctx.AU_CRED_BROKER.registerKnownSecret(SENTINEL);

  const roles = ctx.AU_COLLAB.buildTeamRoles(3, 'specialists');
  const board = ctx.AU_COLLAB.createInitialSharedBoard(roles, '4201');
  const ghCfg = {
    enabled: true,
    repo: 'https://github.com/nadabgfccvd/My-Path',
    fullName: 'nadabgfccvd/My-Path',
    baseBranch: 'main',
    authMode: 'direct_agent_git', // Legacy mode is coerced to vault_broker_zero_token
    token: SENTINEL,
    agentVaultCap: 'cap_test_123456',
    filebinId: 'au4201bin',
    hasVaultCredential: true
  };

  const initialPrompt = ctx.AU_COLLAB.buildInitialAgentPrompt({
    roomId: '4201',
    roomHmacKey: 'aabbccdd11223344',
    basePrompt: `Implemente feature X usando ${SENTINEL}`,
    agentRole: roles[0],
    teamRoles: roles,
    profile: 'specialists',
    stopMode: 'smart_consensus',
    sharedBoard: board,
    tempFileConfig: { enabled: true, filebinId: 'au4201bin', litterboxExpiry: '24h' },
    githubConfig: ghCfg
  });

  const nextPrompt = ctx.AU_COLLAB.buildNextCollabTurnPrompt({
    room: {
      roomId: '4201',
      roomHmacKey: 'aabbccdd11223344',
      filebinId: 'au4201bin',
      stopMode: 'smart_consensus',
      sharedBoard: board
    },
    agent: { name: roles[0].shortTitle, roleTitle: roles[0].roleTitle, isSynthesizer: false },
    unreadMessages: [{ sender: 'Coordenador', text: `Token vazado: ${SENTINEL}`, ts: Date.now() }],
    githubConfig: ghCfg
  });

  assert.equal(initialPrompt.includes('TEST_SECRET_DO_NOT_USE_123456'), false);
  assert.equal(nextPrompt.includes('TEST_SECRET_DO_NOT_USE_123456'), false);
  assert.equal(ctx.AU_CRED_BROKER.containsAnySecret(initialPrompt), false);
  assert.equal(ctx.AU_DEFAULTS.normalizeGithubAuthMode('direct_agent_git'), 'vault_broker_zero_token');
});

// ============================================================================
// A02 — SEC-02 & ARENA-16: Session-Only PAT, Zero Fallback to local, Encrypted Vault
// ============================================================================
test('A02 (SEC-02 & ARENA-16): Plaintext PAT never hits storage.local; missing storage.session refuses fallback; AES-256-GCM disk vault works', async () => {
  const { ctx, chrome } = loadSharedContext();
  const pat = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890';

  await ctx.AU_STORAGE.saveSettings({
    githubToken: pat,
    webhookUrl: 'https://discord.com/api/webhooks/123/secret',
    locale: 'pt-BR'
  });
  const rawLocal = JSON.stringify(chrome._localStore);
  assert.equal(rawLocal.includes(pat), false, 'storage.local must NEVER contain plaintext githubToken');
  assert.equal(rawLocal.includes('discord.com/api/webhooks'), false, 'storage.local must NEVER contain webhookUrl');

  // Encrypt to disk with PBKDF2 (100k) + AES-256-GCM
  await ctx.AU_CRED_BROKER.saveEncryptedVaultToDisk({ githubToken: pat, webhookUrl: '' }, 'StrongPassphrase!2026');
  assert.equal(JSON.stringify(chrome._localStore).includes(pat), false, 'Encrypted vault must not expose plaintext PAT');

  await ctx.AU_CRED_BROKER.clearSessionSecret('githubToken'); // Simulate browser restart wiping storage.session
  await assert.rejects(() => ctx.AU_CRED_BROKER.unlockEncryptedVaultFromDisk('WrongPassphrase!'));
  const unlocked = await ctx.AU_CRED_BROKER.unlockEncryptedVaultFromDisk('StrongPassphrase!2026');
  assert.equal(unlocked.ok, true);
  const sessPat = await ctx.AU_CRED_BROKER.getSessionSecret('githubToken');
  assert.equal(sessPat.value, pat);

  // ARENA-16: When storage.session is unavailable, degraded flag is surfaced and ZERO secret writes hit storage.local
  const degraded = loadSharedContext({ disableSessionStorage: true });
  const degRes = await degraded.ctx.AU_CRED_BROKER.setSessionSecrets({ githubToken: pat });
  assert.equal(degRes.volatileDegraded, true);
  assert.equal(degraded.ctx.AU_CRED_BROKER.isVolatileDegraded(), true);
  assert.equal(JSON.stringify(degraded.chrome._localStore).includes(pat), false);
});

// ============================================================================
// A03 — SEC-03: Sanitized Backup Export & Import Allowlist
// ============================================================================
test('A03 (SEC-03): exportAllData omits secret keys & scrubs chats; importAllData ignores injected secrets', async () => {
  const { ctx, chrome } = loadSharedContext();
  const pat = 'ghp_SecretTokenInChat99887766554433221100';
  await ctx.AU_CRED_BROKER.setSessionSecret('githubToken', pat);
  await ctx.AU_STORAGE.upsertSavedChat({
    id: 'chat_sec03',
    title: 'Teste SEC-03',
    messages: [{ role: 'user', content: `Meu token é ${pat}` }]
  });

  const dump = await ctx.AU_STORAGE.exportAllData();
  const serialized = JSON.stringify(dump);
  assert.equal(serialized.includes(pat), false, 'Backup JSON must scrub inline PATs');
  assert.equal('githubToken' in (dump.settings || {}), false, 'Exported settings must omit githubToken key');
  assert.equal('webhookUrl' in (dump.settings || {}), false, 'Exported settings must omit webhookUrl key');

  await ctx.AU_STORAGE.importAllData({
    settings: { githubToken: pat, webhookUrl: 'https://evil.example/hook', themePreset: 'dracula' }
  });
  const afterLocal = JSON.stringify(chrome._localStore);
  assert.equal(afterLocal.includes(pat), false);
  assert.equal(afterLocal.includes('evil.example'), false);
});

// ============================================================================
// A04 — SEC-06 & ARENA-08: AES-256-GCM Private Bundle Encryption (Magic != PK)
// ============================================================================
test('A04 (SEC-06 & ARENA-08): Private repo external bundle uses AUE1 AES-256-GCM envelope (magic != PK) and blocks unencrypted private upload', async () => {
  const { ctx } = loadSharedContext({ loadServiceWorker: true });
  const zipBytes = ctx.AU_INTEGRATIONS.buildZipArchive([
    { path: 'src/secret.ts', bytes: new TextEncoder().encode('export const KEY = 42;\n') }
  ]);
  assert.equal(String.fromCharCode(zipBytes[0], zipBytes[1]), 'PK');

  const encrypted = await ctx.AU_CRED_BROKER.encryptPrivateBinary(zipBytes, 'RepoSecretPass#2026');
  const magic = String.fromCharCode(encrypted[0], encrypted[1], encrypted[2], encrypted[3]);
  assert.equal(magic, new TextDecoder().decode(ctx.AU_CRED_BROKER.PRIVATE_BUNDLE_MAGIC));
  assert.notEqual(magic.slice(0, 2), 'PK', 'Encrypted bundle must NEVER start with PK magic bytes');

  const decrypted = await ctx.AU_CRED_BROKER.decryptPrivateBinary(encrypted, 'RepoSecretPass#2026');
  assert.deepEqual(Array.from(decrypted), Array.from(zipBytes));

  // Private repo stageRepoSnapshotForProxyIfNeeded without passphrase must NOT upload raw ZIP externally (ARENA-08)
  const stageFn = vm.runInContext('stageRepoSnapshotForProxyIfNeeded', ctx);
  const res = await stageFn(
    { fullName: 'owner/priv-repo', private: true, allowExternalEncryptedUpload: false },
    'ghp_dummy123456789012345678901234567890',
    'bin123'
  );
  assert.equal(Boolean(res), false, 'Private repo without explicit encrypted external opt-in must never return an external URL');
});

// ============================================================================
// A05 — SEC-07: Cross-World Nonce-Authenticated postMessage Handshake & Allowlist
// ============================================================================
test('A05 (SEC-07): Cross-world bridge enforces 2-way CSPRNG nonce handshake, origin check, and strict command allowlist', () => {
  const pageBridgeSrc = fs.readFileSync(path.join(ROOT, 'content', 'page-bridge.js'), 'utf8');
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content', 'content.js'), 'utf8');

  assert.match(pageBridgeSrc, /au-bridge-handshake-init/, 'page-bridge must validate v4 handshake-init');
  assert.match(pageBridgeSrc, /au-bridge-handshake-ack/, 'page-bridge must reply with v4 handshake-ack');
  assert.match(pageBridgeSrc, /ev\.origin !== location\.origin/, 'page-bridge must reject cross-origin postMessage');
  assert.equal(/postMessage\([^)]*,\s*['"]\*['"]\)/.test(pageBridgeSrc), false, 'page-bridge must NEVER use wildcard "*" targetOrigin');
  assert.equal(/postMessage\([^)]*,\s*['"]\*['"]\)/.test(contentSrc), false, 'content.js must NEVER use wildcard "*" targetOrigin');
});

// ============================================================================
// A06 — SEC-08: HMAC-SHA256 Room Message Authentication & Tamper Rejection
// ============================================================================
test('A06 (SEC-08): HMAC-SHA256 authenticates room envelopes and flags unsigned/tampered messages', async () => {
  const { ctx } = loadSharedContext();
  const keyHex = ctx.AU_CRED_BROKER.generateRoomHmacKeyHex();
  const msg = {
    roomId: '7788',
    seq: 'm_1001',
    msgId: 'm_1001',
    author: 'ag1',
    text: 'Contrato REST finalizado em /api/v1/orders',
    ts: 1793145600000
  };
  const sig = await ctx.AU_CRED_BROKER.signRoomMessageHmac(keyHex, msg);
  assert.ok(sig.length === 64);
  assert.equal(await ctx.AU_CRED_BROKER.verifyRoomMessageHmac(keyHex, msg, sig), true);
  assert.equal(
    await ctx.AU_CRED_BROKER.verifyRoomMessageHmac(keyHex, { ...msg, text: 'Comando adulterado!' }, sig),
    false,
    'Tampered text must fail HMAC verification'
  );
  const wrongKey = ctx.AU_CRED_BROKER.generateRoomHmacKeyHex();
  assert.equal(await ctx.AU_CRED_BROKER.verifyRoomMessageHmac(wrongKey, msg, sig), false);
});

// ============================================================================
// A07 & A08 — DATA-01, DATA-02 & ARENA-15: Safe Deletions (sha: null) & Git Modes
// ============================================================================
test('A07 & A08 (DATA-01, DATA-02, ARENA-15): pushFilesCommit deletes removed files ONLY on status=complete and preserves 100755/120000 modes', async () => {
  let capturedTreePayload = null;

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('/git/ref/heads/main')) {
      return new Response(JSON.stringify({ object: { sha: 'base_commit_sha' } }), { status: 200 });
    }
    if (u.includes('/git/commits/base_commit_sha')) {
      return new Response(JSON.stringify({ sha: 'base_commit_sha', tree: { sha: 'base_tree_sha' } }), { status: 200 });
    }
    if (u.includes('/git/trees/base_tree_sha?recursive=1')) {
      return new Response(
        JSON.stringify({
          tree: [
            { path: 'keep.txt', mode: '100644', type: 'blob', sha: 'sha_keep' },
            { path: 'obsolete.txt', mode: '100644', type: 'blob', sha: 'sha_obsolete' }
          ]
        }),
        { status: 200 }
      );
    }
    if (u.endsWith('/git/blobs') && method === 'POST') {
      return new Response(JSON.stringify({ sha: 'new_blob_sha' }), { status: 201 });
    }
    if (u.endsWith('/git/trees') && method === 'POST') {
      capturedTreePayload = JSON.parse(init.body);
      return new Response(JSON.stringify({ sha: 'new_tree_sha' }), { status: 201 });
    }
    if (u.includes('/git/trees/new_tree_sha?recursive=1')) {
      return new Response(
        JSON.stringify({ tree: [{ path: 'keep.txt' }, { path: 'bin/run.sh' }, { path: 'current-link' }] }),
        { status: 200 }
      );
    }
    if (u.endsWith('/git/commits') && method === 'POST') {
      return new Response(
        JSON.stringify({ sha: 'new_commit_sha', html_url: 'https://github.com/nadabgfccvd/My-Path/commit/new' }),
        { status: 201 }
      );
    }
    if (u.includes('/git/refs/heads/main') && method === 'PATCH') {
      return new Response(JSON.stringify({ object: { sha: 'new_commit_sha' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  };

  const { ctx } = loadSharedContext({ fetch: mockFetch });

  // Case 1: PARTIAL snapshot -> MUST NOT emit sha: null for obsolete.txt (ARENA-15 safety invariant!)
  await ctx.AU_INTEGRATIONS.github.pushFilesCommit('ghp_valid123456789012345678901234567890', {
    repo: 'nadabgfccvd/My-Path',
    branch: 'main',
    baseBranch: 'main',
    snapshotStatus: 'partial',
    syncDeletions: true,
    omittedFiles: [{ path: 'big.bin', reason: 'timeout' }],
    files: [{ path: 'keep.txt', bytes: new TextEncoder().encode('updated') }]
  });
  assert.equal(
    capturedTreePayload.tree.some((e) => e.path === 'obsolete.txt' && e.sha === null),
    false,
    'Partial snapshot must NEVER delete missing files with sha: null'
  );
  assert.equal(
    capturedTreePayload.tree.some((e) => e.path === '.au-manifest.json'),
    true,
    'Partial snapshot must attach .au-manifest.json documenting omitted files (DATA-03)'
  );

  // Case 2: COMPLETE snapshot -> MUST emit sha: null for obsolete.txt AND preserve 100755 & 120000 modes!
  capturedTreePayload = null;
  await ctx.AU_INTEGRATIONS.github.pushFilesCommit('ghp_valid123456789012345678901234567890', {
    repo: 'nadabgfccvd/My-Path',
    branch: 'main',
    baseBranch: 'main',
    snapshotStatus: 'complete',
    syncDeletions: true,
    files: [
      { path: 'keep.txt', bytes: new TextEncoder().encode('updated') },
      { path: 'bin/run.sh', bytes: new TextEncoder().encode('#!/usr/bin/env bash\necho ok\n'), executable: true },
      { path: 'current-link', bytes: new TextEncoder().encode('keep.txt'), symlink: true }
    ]
  });

  const delEntry = capturedTreePayload.tree.find((e) => e.path === 'obsolete.txt');
  const execEntry = capturedTreePayload.tree.find((e) => e.path === 'bin/run.sh');
  const linkEntry = capturedTreePayload.tree.find((e) => e.path === 'current-link');
  assert.ok(delEntry && delEntry.sha === null, 'Complete snapshot must emit sha: null for deleted file');
  assert.equal(execEntry.mode, '100755', 'Executable file must preserve 100755 git mode');
  assert.equal(linkEntry.mode, '120000', 'Symlink must preserve 120000 git mode');
});

// ============================================================================
// A09 — DATA-03, DATA-04, DATA-05 & ENG-05: Path Filtering, Forge Guard, Projects v2 & Rate-Limit Backoff
// ============================================================================
test('A09 (DATA-03..05 & ENG-05): Nested src/target allowed, GitLab flagged non-GitHub, Projects v2 GraphQL & 429 Retry-After work', async () => {
  let attempts = 0;
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/graphql')) {
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              projectsV2: {
                nodes: [
                  { id: 'PVT_1', number: 1, title: 'Roadmap v4', url: 'https://github.com/orgs/o/projects/1', closed: false }
                ]
              }
            }
          }
        }),
        { status: 200 }
      );
    }
    attempts++;
    if (attempts === 1) {
      return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '0' } });
    }
    return new Response(JSON.stringify({ login: 'octocat', id: 1 }), { status: 200 });
  };

  const { ctx } = loadSharedContext({ fetch: mockFetch });

  // DATA-03: Root build/target excluded, nested src/target or packages/ui/build preserved!
  assert.equal(ctx.AU_INTEGRATIONS.isExcludedZipPath('build/output.js'), true);
  assert.equal(ctx.AU_INTEGRATIONS.isExcludedZipPath('target/debug/app'), true);
  assert.equal(ctx.AU_INTEGRATIONS.isExcludedZipPath('src/target/handler.ts'), false);
  assert.equal(ctx.AU_INTEGRATIONS.isExcludedZipPath('packages/web/build/helper.js'), false);

  // DATA-04: Non-GitHub forge guard
  const gitlabSpec = ctx.AU_INTEGRATIONS.parseGitRepoSpec('https://gitlab.com/group/project');
  assert.equal(gitlabSpec.isGithub, false);
  assert.equal(gitlabSpec.host, 'gitlab.com');

  // ENG-05: 429 Retry-After backoff recovery
  const verified = await ctx.AU_INTEGRATIONS.github.verifyToken('ghp_test123456789012345678901234567890');
  assert.equal(verified.login, 'octocat');
  assert.equal(attempts >= 2, true, 'GitHub client must retry after 429 Retry-After');

  // DATA-05: Projects v2 GraphQL
  const projects = await ctx.AU_INTEGRATIONS.github.listProjectsV2(
    'ghp_test123456789012345678901234567890',
    'nadabgfccvd/My-Path'
  );
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0].title, 'Roadmap v4');
});

// ============================================================================
// A10 — ARENA-01: Real Python 3 Execution of Parallel /tmp/au_chat CLI
// ============================================================================
test('A10 (ARENA-01): Real /tmp/au_chat Python CLI executes parallel downloads, verifies HMAC, persists atomic state in AU_STATE_DIR, and retries failed blobs', async () => {
  const { ctx } = loadSharedContext();
  const roomHmacKey = ctx.AU_CRED_BROKER.generateRoomHmacKeyHex();
  const shellBlock = ctx.AU_COLLAB.buildRealtimeChatInstructions({
    roomId: '9010',
    filebinId: 'bin9010',
    agentIndex: 1,
    agentName: 'Agente 1',
    roleTitle: 'Arquiteto',
    roomHmacKey
  });
  const pyScript = extractHeredocScript(shellBlock, '/tmp/au_chat');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-chat-test-'));
  const scriptPath = path.join(tmpDir, 'au_chat.py');
  const stateDir = path.join(tmpDir, 'au_state');

  let failSecondMsg = true;
  const ts1 = 1793145601000;
  const id1 = `m_${ts1}_ag2_101`;
  const text1 = 'Mensagem paralela 1 validada!';
  const sig1 = await ctx.AU_CRED_BROKER.signRoomMessageHmac(roomHmacKey, {
    roomId: '9010',
    seq: id1,
    msgId: id1,
    author: 'ag2',
    ts: ts1,
    text: text1
  });
  const msg1Obj = {
    id: id1,
    roomId: '9010',
    sender: 'Agente 2',
    role: 'Engenheiro',
    tag: 'ag2',
    text: text1,
    ts: ts1,
    hmacSig: sig1
  };

  const ts2 = 1793145602000;
  const id2 = `m_${ts2}_ag2_102`;
  const text2 = 'Mensagem paralela 2 recuperada apos falha!';
  const sig2 = await ctx.AU_CRED_BROKER.signRoomMessageHmac(roomHmacKey, {
    roomId: '9010',
    seq: id2,
    msgId: id2,
    author: 'ag2',
    ts: ts2,
    text: text2
  });
  const msg2Obj = {
    id: id2,
    roomId: '9010',
    sender: 'Agente 2',
    role: 'Engenheiro',
    tag: 'ag2',
    text: text2,
    ts: ts2,
    hmacSig: sig2
  };

  const fn1 = `auchat_${ts1}_ag2_101.json`;
  const fn2 = `auchat_${ts2}_ag2_102.json`;

  const server = http.createServer((req, res) => {
    if (req.url === '/bin9010') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files: [{ filename: fn1 }, { filename: fn2 }] }));
      return;
    }
    if (req.url === `/bin9010/${fn1}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(msg1Obj));
      return;
    }
    if (req.url === `/bin9010/${fn2}`) {
      if (failSecondMsg) {
        res.writeHead(500);
        res.end('Transient error');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(msg2Obj));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const patchedPy = pyScript.replaceAll('https://filebin.net', `http://127.0.0.1:${port}`);
    fs.writeFileSync(scriptPath, patchedPy, { mode: 0o755 });

    const pyEnv = {
      ...process.env,
      AU_STATE_DIR: stateDir,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      HTTP_PROXY: '',
      http_proxy: ''
    };
    // Run 1: msg1 succeeds, msg2 returns HTTP 500 -> msg2 MUST NOT be marked seen!
    const { stdout: out1 } = await execFileAsync('python3', [scriptPath, 'read'], {
      env: pyEnv,
      encoding: 'utf8'
    });
    assert.match(out1, /Mensagem paralela 1 validada!/);
    assert.equal(fs.existsSync(stateDir), true, 'Durable state dir must be created');

    // Run 2: server recovers -> msg2 is now fetched and printed while msg1 is NOT duplicated!
    failSecondMsg = false;
    const { stdout: out2 } = await execFileAsync('python3', [scriptPath, 'read'], {
      env: pyEnv,
      encoding: 'utf8'
    });
    assert.equal(out2.includes('Mensagem paralela 1 validada!'), false, 'msg1 must not duplicate');
    assert.match(out2, /Mensagem paralela 2 recuperada apos falha!/, 'Failed blob must be retried on next read');
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// A11, A12, A13 — ARENA-02, ARENA-03, ARENA-04: Reasoning Scrub, SPA Guard & WAITING_USER
// ============================================================================
test('A11, A12 & A13 (ARENA-02..04): Strips <details>/<thought> reasoning, detects SPA route switch, and pauses on interactive cards', () => {
  const { ctx } = loadSharedContext();

  // ARENA-02: Serialized reasoning scrub
  const scrubbed = ctx.AU_ARENA_ADAPTER.scrubSerializedReasoning(
    '<thought>Segredo interno de raciocínio</thought>\n<details><summary>Thinking...</summary> Passo oculto </details>\nResposta final limpa!'
  );
  assert.equal(scrubbed.text.includes('Segredo interno'), false);
  assert.equal(scrubbed.text.includes('Passo oculto'), false);
  assert.match(scrubbed.text, /Resposta final limpa!/);
  assert.equal(scrubbed.strippedBlocks, 2);

  // ARENA-03: SPA route switch detection
  const idA = ctx.AU_ARENA_ADAPTER.getConversationIdentity('https://arena.ai/c/conv-aaa-111');
  const idB = ctx.AU_ARENA_ADAPTER.getConversationIdentity('https://arena.ai/c/conv-bbb-222');
  assert.equal(ctx.AU_ARENA_ADAPTER.didSwitchConversation(idA, idB), true);
  assert.equal(ctx.AU_ARENA_ADAPTER.didSwitchConversation(idB, idB), false);

  // ARENA-04: Interactive ask_user card detection
  const mockBtn = {
    getBoundingClientRect: () => ({ width: 80, height: 32 }),
    closest: () => null,
    getAttribute: () => ''
  };
  const mockCard = {
    innerText: 'Which database do you prefer?\nOption A\nOption B\nSubmit',
    textContent: 'Which database do you prefer?\nOption A\nOption B\nSubmit',
    getBoundingClientRect: () => ({ width: 420, height: 180 }),
    closest: () => null,
    getAttribute: (a) => (a === 'data-tool-name' ? 'ask_user' : ''),
    querySelectorAll: () => [mockBtn, mockBtn]
  };
  const mockDoc = {
    querySelector: () => ({ querySelectorAll: () => [mockCard] }),
    querySelectorAll: () => [mockCard]
  };
  const pending = ctx.AU_ARENA_ADAPTER.findPendingHumanInteraction(mockDoc);
  assert.equal(pending.pending, true);
  assert.equal(pending.kind, 'ask_user');
});

// ============================================================================
// A14, A15, A16 — ARENA-05, ARENA-06, ARENA-09, ARENA-11: Leader Re-Election, Zen CSS, Attachments & PARAR TUDO
// ============================================================================
test('A14, A15 & A16 (ARENA-05, ARENA-06, ARENA-09, ARENA-11): Monotonic leaderEpoch re-election, safe Zen CSS, and <2s PARAR TUDO kill switch', async () => {
  const { ctx, chrome } = loadSharedContext({ loadServiceWorker: true });

  // A15: Zen Mode CSS must NEVER hide global `aside` or `[class*="sidebar"]`
  const themesSrc = fs.readFileSync(path.join(ROOT, 'content', 'themes.js'), 'utf8');
  assert.equal(/\[class\*=["']sidebar["']\]/.test(themesSrc), false, 'Zen Mode must never match group/sidebar-wrapper');
  assert.equal(/(^|\s|,)aside\s*\{[^}]*display\s*:\s*none/i.test(themesSrc), false, 'Zen Mode must never hide Workspace <aside>');

  // A14: Leader failure triggers monotonic leaderEpoch re-election
  chrome._openTabs.set(201, { id: 201, url: 'https://arena.ai/c/a1', title: 'Agent 1', windowId: 1 });
  chrome._openTabs.set(202, { id: 202, url: 'https://arena.ai/c/a2', title: 'Agent 2', windowId: 1 });
  chrome._openTabs.set(203, { id: 203, url: 'https://arena.ai/c/a3', title: 'Agent 3', windowId: 1 });

  const createFromOpen = vm.runInContext('createCollabRoomFromOpenTabs', ctx);
  const ensureLeader = vm.runInContext('ensureHealthySynthesizerLeader', ctx);
  const created = await createFromOpen({ profile: 'specialists', stopMode: 'smart_consensus', refuseThinkingModels: false });
  assert.ok(created && created.roomId);
  const room = vm.runInContext(`COLLAB_ROOMS.get(${JSON.stringify(created.roomId)})`, ctx);
  const initialEpoch = room.leaderEpoch || 1;
  const oldLeader = room.agents.find((a) => a.isSynthesizer);
  assert.ok(oldLeader, 'Room must start with an elected synthesizer');
  oldLeader.closed = true; // Simulate leader tab crash/close

  const election = ensureLeader(room);
  assert.equal(election.changed || room.leaderEpoch > initialEpoch, true);
  assert.equal(room.leaderEpoch, initialEpoch + 1, 'leaderEpoch must increment monotonically');
  const newLeader = room.agents.find((a) => a.isSynthesizer && !a.closed);
  assert.ok(newLeader && newLeader.tabId !== oldLeader.tabId);

  // A16: Global Kill Switch PARAR TUDO (< 2s)
  const t0 = Date.now();
  const stopRes = await chrome._dispatchMessage({ type: 'AU_EMERGENCY_STOP_ALL' });
  const elapsedMs = Date.now() - t0;
  assert.equal(stopRes.ok, true);
  assert.equal(elapsedMs < 2000, true, `PARAR TUDO took ${elapsedMs}ms (must be < 2000ms)`);
  assert.equal(room.status, 'paused');
});

// ============================================================================
// A17 & A18 — ARENA-12, PROD-14 & ARENA-17: Consensus Matrix, Pre-PR Quality Gate & Uncertainty Reconciler
// ============================================================================
test('A17 & A18 (ARENA-12, PROD-14, ARENA-17): Consensus Matrix blocks premature stop, Pre-PR Quality Gate catches syntax/secrets, and uncertain git ops reconcile', () => {
  const { ctx } = loadSharedContext({ loadServiceWorker: true });

  const roles = ctx.AU_COLLAB.buildTeamRoles(3, 'specialists');
  const board = ctx.AU_COLLAB.createInitialSharedBoard(roles, '5150');
  ctx.AU_COLLAB.upsertBoardAssignment(board, 'ag1', { status: 'bloqueado', notes: 'Falta endpoint OAuth' }, 'Agente 1');

  const matrixPending = ctx.AU_COLLAB.computeRoomConsensusMatrix({
    agents: [
      { index: 0, name: 'Agente 1', admittedToTeam: true, closed: false, turnsCount: 2 },
      { index: 1, name: 'Agente 2', admittedToTeam: true, closed: false, turnsCount: 2 },
      { index: 2, name: 'Agente 3', admittedToTeam: true, closed: false, isSynthesizer: true, turnsCount: 1 }
    ],
    sharedBoard: board,
    messages: []
  });
  assert.equal(matrixPending.isUnanimousConsensus, false);
  assert.equal(matrixPending.isMajorityApproved, false);

  // PROD-14: Pre-PR Quality Gate
  const runGate = vm.runInContext('runPrePrQualityGate', ctx);
  const badGate = runGate([
    { path: 'broken.json', content: '{ invalid json ' },
    { path: 'leak.js', content: 'const tok = "ghp_1234567890abcdefghijklmnopqrstuvwx";' }
  ]);
  assert.equal(badGate.ok, false);
  assert.equal(badGate.issues.length >= 2, true);

  const goodGate = runGate([{ path: 'valid.json', content: '{"ok":true}' }]);
  assert.equal(goodGate.ok, true);
});

// ============================================================================
// A19, A20, A21 & A22 — ARENA-18 & §7.5 M1-M5: Strict Room Isolation, Anti-Hijack & Legacy Migration
// ============================================================================
test('A19, A20, A21 & A22 (ARENA-18 + M1-M5): Cross-room leak is quarantined, URL/payload hijack blocked, bindingEpoch preserved, per-room Filebin isolated, and v3 rooms migrate cleanly', async () => {
  const { ctx, chrome } = loadSharedContext({ loadServiceWorker: true });
  const createFromOpen = vm.runInContext('createCollabRoomFromOpenTabs', ctx);
  const mergeTabState = vm.runInContext('mergeTabStatePreservingRoomAuthority', ctx);
  const migrateLegacy = vm.runInContext('migrateLegacyRoomObject', ctx);

  // Create Room A with tabs 301, 302
  chrome._openTabs.set(301, { id: 301, url: 'https://arena.ai/c/ra1', title: 'Room A Agent 1', windowId: 1 });
  chrome._openTabs.set(302, { id: 302, url: 'https://arena.ai/c/ra2', title: 'Room A Agent 2', windowId: 1 });
  await vm.runInContext('syncOpenArenaTabs()', ctx);
  const resA = await createFromOpen({ profile: 'specialists', refuseThinkingModels: false, tabIds: [301, 302] });
  const roomA = vm.runInContext(`COLLAB_ROOMS.get(${JSON.stringify(resA.roomId)})`, ctx);

  // Create Room B with tabs 401, 402
  chrome._openTabs.set(401, { id: 401, url: 'https://arena.ai/c/rb1', title: 'Room B Agent 1', windowId: 1 });
  chrome._openTabs.set(402, { id: 402, url: 'https://arena.ai/c/rb2', title: 'Room B Agent 2', windowId: 1 });
  await vm.runInContext('syncOpenArenaTabs()', ctx);
  const resB = await createFromOpen({ profile: 'specialists', refuseThinkingModels: false, tabIds: [401, 402] });
  const roomB = vm.runInContext(`COLLAB_ROOMS.get(${JSON.stringify(resB.roomId)})`, ctx);

  // A21: Cryptographically distinct per-room Filebin buckets & HMAC keys
  assert.notEqual(roomA.roomId, roomB.roomId);
  assert.notEqual(roomA.filebinId, roomB.filebinId, 'Rooms A and B must NEVER share a Filebin bucket');
  assert.notEqual(roomA.roomHmacKey, roomB.roomHmacKey, 'Rooms A and B must have distinct HMAC keys');

  // A19: Tab 301 (bound to Room A) attempts to inject a live prose message claiming roomId = Room B!
  const leakAttempt = await chrome._dispatchMessage(
    {
      type: 'AU_COLLAB_LIVE_PROSE_MSG',
      payload: {
        roomId: roomB.roomId, // Forged cross-room target!
        text: 'Mensagem vazada da Sala A na Sala B!'
      }
    },
    { tab: { id: 301, url: 'https://arena.ai/c/ra1' } }
  );

  assert.equal(leakAttempt.ok, false, 'Cross-room message from Tab 301 into Room B must be rejected');
  assert.equal(leakAttempt.rejectedCrossRoom, true);
  assert.equal(
    roomB.messages.some((m) => String(m.text || '').includes('Mensagem vazada')),
    false,
    'Zero messages from Room A may enter Room B'
  );
  assert.equal(roomB.quarantinedCrossRoomCount >= 1, true, 'Quarantined cross-room counter must increment');

  // A20: Content script / URL hash tries to overwrite collabRoomId on Tab 301 via mergeTabStatePreservingRoomAuthority
  const authoritative = vm.runInContext('TAB_STATES.get(301)', ctx);
  const merged = mergeTabState(301, authoritative, {
    collabRoomId: roomB.roomId, // Untrusted payload hijack attempt!
    collabAgentName: 'Hijacked',
    bindingEpoch: 999999
  });
  assert.equal(merged.collabRoomId, roomA.roomId, 'SW must preserve authoritative collabRoomId and ignore untrusted payload');
  assert.equal(merged.bindingEpoch, authoritative.bindingEpoch, 'SW must preserve authoritative bindingEpoch');

  // A22: Legacy v3.x room migration (M1-M5)
  const seenTabs = new Set([301]); // Tab 301 is already owned by active Room A!
  const legacyRoom = {
    roomId: '3300',
    status: 'active',
    filebinId: 'bin_shared_short', // Legacy non-isolated bucket!
    agents: [
      { tabId: 301, name: 'Agente Conflitante', closed: false },
      { tabId: 399, name: 'Agente Legitimo', closed: false }
    ],
    messages: [
      { id: 'm1', sender: 'Agente Legitimo', text: 'Oi da sala 3300', roomId: '3300', ts: Date.now() - 5000 },
      { id: 'm2', sender: 'Fantasma', text: 'Vazamento antigo', roomId: '9999', ts: Date.now() - 4000 }
    ]
  };
  migrateLegacy(legacyRoom, seenTabs);
  assert.ok(legacyRoom.roomHmacKey && legacyRoom.roomHmacKey.length >= 32, 'M3: Legacy room must receive HMAC key');
  assert.equal(legacyRoom.agents.find((a) => a.tabId === 301).closed, true, 'M2: Duplicate tab ownership must be detached');
  assert.equal(
    legacyRoom.messages.some((m) => m.text === 'Vazamento antigo'),
    false,
    'M4: Foreign-room message in legacy history must be quarantined out of messages[]'
  );
  assert.equal(legacyRoom.messages.some((m) => m.text === 'Oi da sala 3300'), true);
});

// ============================================================================
// A23 — PROD-01..08: Unified Multi-Agent Diff, Global Search, Cron, Memory & Plugins
// ============================================================================
test('A23 (PROD-01..08): Unified multi-agent LCS diff detects conflict vs clean merge; Cron, Codebase Memory, Search & Plugins work', async () => {
  const { ctx } = loadSharedContext();

  // PROD-01: Multi-Agent Unified Diff & Conflict Matrix
  const baseFiles = { 'src/app.js': { text: 'line1\nline2\nline3\n' } };
  const report = ctx.AU_DIFF.computeMultiAgentRoomDiff(
    [
      {
        agentTag: 'AG1',
        agentLabel: 'Agente 1',
        files: [
          { path: 'src/app.js', text: 'line1\nagent1_edit\nline3\n' },
          { path: 'src/only1.js', text: 'export const a = 1;\n' }
        ]
      },
      {
        agentTag: 'AG2',
        agentLabel: 'Agente 2',
        files: [{ path: 'src/app.js', text: 'line1\nagent2_conflicting_edit\nline3\n' }]
      }
    ],
    baseFiles
  );
  assert.equal(report.conflictCount, 1, 'Overlapping edits on src/app.js must be flagged as conflict');
  assert.match(report.conflicts[0].unifiedDiff, /\+\+\+ /);

  // PROD-03: 5-field Cron parser
  const baseTime = Date.UTC(2026, 9, 28, 8, 30, 0); // 08:30 UTC
  const next9am = ctx.AU_SCHEDULER.computeNextCronTimestamp('0 9 * * *', baseTime);
  assert.ok(next9am > baseTime && next9am - baseTime <= 3600 * 1000 * 24);

  // PROD-04: Persistent Codebase Memory
  await ctx.AU_STORAGE.saveRepoMemory('nadabgfccvd/My-Path', {
    architecture: 'MV3 Extension Zero-Build',
    conventions: ['Zero deps', 'PT-BR default']
  });
  const mem = await ctx.AU_STORAGE.getRepoMemory('nadabgfccvd/My-Path');
  assert.equal(mem.architecture, 'MV3 Extension Zero-Build');
  const brief = ctx.AU_COLLAB.buildCodebaseBriefingBlock(mem);
  assert.match(brief, /MV3 Extension Zero-Build/);

  // PROD-02: Global Search Index
  await ctx.AU_STORAGE.upsertSavedChat({
    id: 'search_1',
    title: 'Arquitetura OAuth Zero-Token',
    messages: [{ role: 'assistant', content: 'Implementamos PBKDF2 com 100000 iteracoes.' }]
  });
  const hits = await ctx.AU_STORAGE.searchGlobalIndex('PBKDF2');
  assert.equal(hits.length >= 1, true);

  // PROD-08: CSP-safe declarative plugin dispatch (no eval / new Function)
  await ctx.AU_PLUGINS.upsertPlugin({
    id: 'pl_test',
    name: 'Tag Release',
    event: 'onRoomCompleted',
    actionType: 'append_board_note',
    config: { note: ' Auditado pelo plugin declarativo' },
    enabled: true
  });
  const plRes = await ctx.AU_PLUGINS.dispatchPluginEvent('onRoomCompleted', { roomId: '1234', text: 'Entrega concluida' });
  assert.ok(plRes);
});

// ============================================================================
// A24 — PROD-11, UX-01, UX-04, ENG-01 & ENG-11: Real OOXML .docx, i18n, Diagnostics & Deadlock Detector
// ============================================================================
test('A24 (PROD-11, UX-01, UX-04, ENG-01, ENG-11): Generates valid OOXML .docx ZIP, full PT/EN/ES i18n, sanitized diagnostics & deadlock recovery', async () => {
  const { ctx, chrome } = loadSharedContext({ loadServiceWorker: true });

  // PROD-11: Real OOXML .docx (ZIP containing [Content_Types].xml & word/document.xml)
  const chat = {
    id: 'docx_1',
    title: 'Relatório Executivo Arena Ultra v4.0',
    messages: [
      { role: 'user', content: 'Gere o relatório final.' },
      { role: 'assistant', content: 'Todos os 24 cenários A01-A24 homologados com sucesso!' }
    ]
  };
  const docxBytes = ctx.AU_STORAGE.buildChatDocxBytes(chat);
  assert.equal(docxBytes[0], 0x50); // 'P'
  assert.equal(docxBytes[1], 0x4b); // 'K'
  const entries = await ctx.AU_INTEGRATIONS.extractZipArchive(docxBytes);
  const paths = entries.map((e) => e.path);
  assert.equal(paths.includes('[Content_Types].xml'), true, '.docx must contain [Content_Types].xml');
  assert.equal(paths.includes('word/document.xml'), true, '.docx must contain word/document.xml');
  const docXml = new TextDecoder().decode(entries.find((e) => e.path === 'word/document.xml').bytes);
  assert.match(docXml, /Todos os 24 cenários A01-A24 homologados com sucesso!/);

  const execMd = ctx.AU_STORAGE.formatChatAsExecutiveSummary(chat);
  assert.match(execMd, /Relatório Executivo Arena Ultra v4\.0/);

  // UX-01: i18n catalog completeness across pt-BR, en, es
  for (const loc of ['pt-BR', 'en', 'es']) {
    ctx.AU_I18N.setLocale(loc);
    const killLabel = ctx.AU_I18N.t('action.emergency_stop');
    assert.ok(killLabel && killLabel.length > 3, `Locale ${loc} must translate action.emergency_stop`);
  }

  // UX-04 & ENG-01: Structured diagnostic ring buffer + sanitized report
  const pat = 'ghp_DiagSecretShouldNeverLeak9876543210';
  await ctx.AU_STORAGE.recordDiagnostic('error', 'vault', `Falha simulada com ${pat}`);
  const diagReport = await ctx.AU_STORAGE.exportSanitizedDiagnosticReport();
  assert.equal(JSON.stringify(diagReport).includes(pat), false, 'Diagnostic export must scrub secrets');

  // ENG-11: Circular Wait / All-Agents-Waiting Deadlock Detector & Auto-Resolve
  chrome._openTabs.clear();
  chrome._openTabs.set(701, { id: 701, url: 'https://arena.ai/c/dl1', title: 'DL Agent 1', windowId: 1 });
  chrome._openTabs.set(702, { id: 702, url: 'https://arena.ai/c/dl2', title: 'DL Agent 2', windowId: 1 });
  const createFromOpen = vm.runInContext('createCollabRoomFromOpenTabs', ctx);
  const dlCreated = await createFromOpen({ profile: 'specialists', refuseThinkingModels: false });
  const dlRoom = vm.runInContext(`COLLAB_ROOMS.get(${JSON.stringify(dlCreated.roomId)})`, ctx);
  for (const a of dlRoom.agents) {
    a.admittedToTeam = true;
    a.screeningStatus = 'admitted';
    a.waitingSince = Date.now() - 45000; // Both waiting > 25s -> Deadlock!
  }
  const dlRes = await chrome._dispatchMessage({ type: 'AU_DEADLOCK_DIAGNOSE', autoResolve: true });
  assert.equal(dlRes.ok, true);
  const dlEntry = dlRes.reports.find((r) => r.roomId === dlRoom.roomId);
  assert.ok(dlEntry);
  assert.equal(dlEntry.deadlockDetected, true);
  assert.equal(dlEntry.resolved, true);
});

// ============================================================================
// Subtest 16 — Real Python 3 Execution of /tmp/au_gh Zero-Token Vault Broker CLI
// ============================================================================
test('Subtest 16 (SEC-01 + DATA-02): Real /tmp/au_gh Python CLI executes Zero-Token Vault Broker RPC with zero PAT in script', async () => {
  const { ctx } = loadSharedContext();
  const roles = ctx.AU_COLLAB.buildTeamRoles(2, 'specialists');
  const ghSh = ctx.AU_COLLAB.buildGithubInstructions(
    {
      enabled: true,
      repo: 'https://github.com/acme-sec/private-vault-repo',
      fullName: 'acme-sec/private-vault-repo',
      baseBranch: 'main',
      authMode: 'vault_broker_zero_token',
      filebinId: 'vaultbin8800',
      agentVaultCap: 'cap_secret_nonce_8800',
      hasVaultCredential: true
    },
    roles[0],
    '8800'
  );
  const pyGh = extractHeredocScript(ghSh, '/tmp/au_gh');
  assert.equal(/ghp_|github_pat_/.test(pyGh), false, '/tmp/au_gh must contain zero GitHub PATs');

  const vaultResponses = new Map();
  const server = http.createServer((req, res) => {
    const mReq = req.url.match(/^\/vaultbin8800\/auvault_req_(.+)\.json$/);
    if (req.method === 'POST' && mReq) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.cap, 'cap_secret_nonce_8800');
        assert.equal(parsed.action, 'overview');
        vaultResponses.set(mReq[1], {
          ok: true,
          data: {
            repo: { fullName: 'acme-sec/private-vault-repo', defaultBranch: 'main', private: true },
            branches: [{ name: 'main' }],
            pulls: [{ number: 42, title: 'feat: Arena Ultra v4.0' }],
            issues: []
          }
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    const mRes = req.url.match(/^\/vaultbin8800\/auvault_res_(.+)\.json$/);
    if (req.method === 'GET' && mRes && vaultResponses.has(mRes[1])) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(vaultResponses.get(mRes[1])));
      return;
    }
    // Unauthenticated GitHub API returns 404 for private repo -> triggers Zero-Token Vault Broker RPC!
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"message":"Not Found"}');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-gh-test-'));
  const ghPath = path.join(tmpDir, 'au_gh.py');
  try {
    const patched = pyGh
      .replaceAll('https://filebin.net', `http://127.0.0.1:${port}`)
      .replaceAll('https://api.github.com', `http://127.0.0.1:${port}`)
      .replace('time.sleep(1.5)', 'time.sleep(0.08)');
    fs.writeFileSync(ghPath, patched, { mode: 0o755 });
    const { stdout } = await execFileAsync('python3', [ghPath, 'overview'], {
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTP_PROXY: '', http_proxy: '' },
      encoding: 'utf8'
    });
    assert.match(stdout, /COFRE ZERO-TOKEN/);
    assert.match(stdout, /acme-sec\/private-vault-repo/);
    assert.match(stdout, /#42 feat: Arena Ultra v4\.0/);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// A25 — v4.1.0: Scalable N-Agent Unified Team Roles & Anti-Competition Pact (N = 2..25)
// ============================================================================
test('A25 (v4.1.0): Scalable N-Agent roles (2, 3, 5, 12, 25) enforce Unified Team Pact, @Agente handles, and Phase-1 Role Division', () => {
  const { ctx } = loadSharedContext();

  for (const teamSize of [2, 3, 5, 12, 25]) {
    for (const profile of ['specialists', 'parallel_leader', 'debate_consensus']) {
      const roles = ctx.AU_COLLAB.buildTeamRoles(teamSize, profile);
      assert.equal(roles.length, teamSize, `Expected ${teamSize} roles for profile=${profile}`);
      const synthCount = roles.filter((r) => r.isSynthesizer).length;
      assert.equal(synthCount, 1, `Exactly 1 synthesizer/integrator expected for N=${teamSize} (${profile})`);

      const handles = new Set(roles.map((r) => r.mentionHandle));
      assert.equal(handles.size, teamSize, 'Every agent must have a unique @AgenteK handle');

      // Check initial prompt contains Unified Team Pact, full N-agent roster, and Phase 1 Huddle protocol
      const board = ctx.AU_COLLAB.createInitialSharedBoard(roles, '7710');
      const p0 = ctx.AU_COLLAB.buildInitialAgentPrompt({
        roomId: '7710',
        filebinId: 'bin7710',
        profile,
        agentRole: roles[0],
        teamRoles: roles,
        sharedBoard: board,
        basePrompt: 'Construir plataforma colaborativa full-stack com API, UI, banco e testes'
      });
      assert.match(p0, /PACTO DE TIME UNIDO — ZERO COMPETIÇÃO/);
      assert.match(p0, /FASE 1 — RODA DE ALINHAMENTO, CONVERSA & DIVISÃO DE PAPÉIS/);
      assert.match(p0, new RegExp(`@Agente${teamSize}\\b`));
      // Clean Chat extractor still recovers the exact user objective cleanly
      assert.equal(
        ctx.AU_DEFAULTS.extractCleanObjectiveFromAutoPrompt(p0),
        'Construir plataforma colaborativa full-stack com API, UI, banco e testes'
      );
    }
  }
});

// ============================================================================
// A26 — v4.1.0: Anti-Pollution Digest, Zero Round-2+ Python Bloat, Top @Mentions & File Overlap Radar
// ============================================================================
test('A26 (v4.1.0): Round 2+ omits giant Python heredoc, surfaces @Mentions at top, strips code dumps, and flags file overlaps', () => {
  const { ctx } = loadSharedContext();

  const roles = ctx.AU_COLLAB.buildTeamRoles(4, 'specialists');
  const board = ctx.AU_COLLAB.createInitialSharedBoard(roles, '7720');
  // Simulate Agente 2 and Agente 3 accidentally claiming overlapping files (`src/api/*` vs `src/api/auth.js`)
  ctx.AU_COLLAB.upsertBoardAssignment(board, 'ag1', { status: 'em_progresso', files: 'src/core/*', notes: 'Contratos core' }, 'Agente 1');
  ctx.AU_COLLAB.upsertBoardAssignment(board, 'ag2', { status: 'em_progresso', files: 'src/api/*', notes: 'Rotas HTTP' }, 'Agente 2');
  ctx.AU_COLLAB.upsertBoardAssignment(board, 'ag3', { status: 'em_progresso', files: 'src/api/auth.js, tests/*', notes: 'Validação Auth' }, 'Agente 3');

  const overlaps = ctx.AU_COLLAB.detectBoardFileOverlaps(board);
  assert.equal(overlaps.length, 1, 'Must detect wildcard vs nested file collision in src/api');
  assert.match(overlaps[0].path, /^src\/api/);

  // Giant raw code block inside a peer reply must be sanitized into a concise workspace reference
  const noisyReply = [
    '[TEMPCHAT]',
    '@Agente2 e @Todos: publiquei os contratos base em `src/core/types.js`. @Agente2 concorda com o formato JSON de erro?',
    '```javascript',
    Array.from({ length: 40 }, (_, i) => `export const line_${i} = ${i};`).join('\n'),
    '```',
    '[/TEMPCHAT]'
  ].join('\n');

  const extracted = ctx.AU_COLLAB.extractTempChatShare(noisyReply, '', { slotKey: 'ag1', authorName: 'Agente 1' });
  assert.equal(extracted.usedTag, true);
  assert.equal(extracted.shareText.includes('export const line_25'), false, 'Giant code blocks must not pollute TempChat');
  assert.match(extracted.shareText, /trecho de código.*salvo no workspace/);

  const round2PromptForAg2 = ctx.AU_COLLAB.buildNextCollabTurnPrompt({
    roomId: '7720',
    filebinId: 'bin7720',
    roundNumber: 2,
    compactChatCli: true,
    totalTeamCount: 4,
    sharedBoard: board,
    agentRole: roles[1], // Agente 2
    unreadMessages: [
      {
        seq: 1,
        senderType: 'agent',
        senderName: roles[0].shortTitle,
        senderRole: roles[0].roleTitle,
        text: extracted.shareText
      }
    ]
  });

  // 1. Zero Python heredoc bloat on Round 2+!
  assert.equal(round2PromptForAg2.includes('#!/usr/bin/env python3'), false, 'Round 2+ must NOT re-inject 165-line Python heredoc');
  assert.match(round2PromptForAg2, /au_chat sync/);
  assert.ok(round2PromptForAg2.length <= 2000);
  assert.match(round2PromptForAg2, /🎯.*@Agente2/);
  assert.equal(round2PromptForAg2.includes('DIVISÃO VIVA DO TIME'), false);
  assert.match(round2PromptForAg2, /Conflito de arquivo em `src\/api/);

});

// ============================================================================
// A27 — v4.1.0: 5-Agent Synchronized Round Barrier, Instant Peer Wake-Up & Round-1 Premature Stop Guard
// ============================================================================
test('A27 (v4.1.0): 5-agent room holds Round-1 huddle barrier until all 5 finish, wakes waiting peers, and gives 100% visibility on Round 2', async () => {
  const { ctx, chrome } = loadSharedContext({ loadServiceWorker: true });

  for (let i = 1; i <= 5; i++) {
    chrome._openTabs.set(500 + i, {
      id: 500 + i,
      url: `https://arena.ai/c/team5-ag${i}`,
      title: `Team5 Agent ${i}`,
      windowId: 1
    });
  }

  const createFromOpen = vm.runInContext('createCollabRoomFromOpenTabs', ctx);
  const created = await createFromOpen({
    baseTask: 'Criar sistema modular em time unido de 5 agentes',
    profile: 'specialists',
    stopMode: 'smart_consensus',
    refuseThinkingModels: false
  });
  const roomId = created.roomId;
  const room = vm.runInContext(`COLLAB_ROOMS.get(${JSON.stringify(roomId)})`, ctx);
  assert.equal(room.agents.length, 5);

  // Mark all 5 tabs as actively generating Round 1
  for (const ag of room.agents) {
    vm.runInContext(
      `TAB_STATES.set(${ag.tabId}, Object.assign(TAB_STATES.get(${ag.tabId}) || {}, { tabId: ${ag.tabId}, status: 'generating', autoContinueEnabled: true, collabRoomId: ${JSON.stringify(roomId)}, bindingEpoch: ${ag.bindingEpoch} }))`,
      ctx
    );
  }

  // 1. Agent 1 finishes Round 1 first -> must wait_peers!
  vm.runInContext(`TAB_STATES.get(501).status = 'idle'`, ctx);
  const resAg1First = await chrome._dispatchMessage(
    {
      type: 'AU_COLLAB_TURN_COMPLETED',
      payload: {
        roomId,
        bindingEpoch: room.agents[0].bindingEpoch,
        assistantText: '[TEMPCHAT] @Todos Sou @Agente1, assumo `src/core/*`. @Agente2 pode assumir `src/ui/*`? [/TEMPCHAT]'
      }
    },
    { tab: { id: 501 } }
  );
  assert.equal(resAg1First.action, 'wait_peers', 'Fast Agent 1 must wait at Round-1 barrier');
  vm.runInContext(`TAB_STATES.get(501).collabWaitingPeers = true`, ctx);

  // 2. Agent 2 finishes Round 1 -> Agents 3, 4, 5 are STILL generating Round 1!
  // Previously, Agent 1 broke out of wait_peers prematurely because unreadMessages.length became 1!
  // Now, Agent 1 MUST STILL hold at the Round-1 barrier until Agents 3, 4, 5 also finish Round 1!
  vm.runInContext(`TAB_STATES.get(502).status = 'idle'`, ctx);
  const resAg2First = await chrome._dispatchMessage(
    {
      type: 'AU_COLLAB_TURN_COMPLETED',
      payload: {
        roomId,
        bindingEpoch: room.agents[1].bindingEpoch,
        assistantText: '[TEMPCHAT] @Agente1 Combinado! Sou @Agente2 e assumo `src/ui/*`. [/TEMPCHAT]'
      }
    },
    { tab: { id: 502 } }
  );
  assert.equal(resAg2First.action, 'wait_peers', 'Agent 2 must also wait for Agents 3..5 to finish Round 1');

  const resAg1PollMid = await chrome._dispatchMessage(
    {
      type: 'AU_COLLAB_TURN_COMPLETED',
      payload: {
        roomId,
        bindingEpoch: room.agents[0].bindingEpoch,
        assistantText: '[TEMPCHAT] @Todos Sou @Agente1, assumo `src/core/*`. @Agente2 pode assumir `src/ui/*`? [/TEMPCHAT]'
      }
    },
    { tab: { id: 501 } }
  );
  assert.equal(resAg1PollMid.action, 'wait_peers', 'Agent 1 MUST NOT rush to Round 2 while Agents 3..5 are still in Round 1');

  // 3. Agents 3 & 4 finish Round 1; Agent 5 (Synthesizer) tries to prematurely emit [ENTREGA_FINAL_PRONTA] on Round 1!
  for (const idx of [2, 3]) {
    const ag = room.agents[idx];
    vm.runInContext(`TAB_STATES.get(${ag.tabId}).status = 'idle'`, ctx);
    const r = await chrome._dispatchMessage(
      {
        type: 'AU_COLLAB_TURN_COMPLETED',
        payload: {
          roomId,
          bindingEpoch: ag.bindingEpoch,
          assistantText: `[TEMPCHAT] @Todos Sou @Agente${idx + 1}, assumo \`src/mod${idx + 1}/*\`. [/TEMPCHAT]`
        }
      },
      { tab: { id: ag.tabId } }
    );
    assert.equal(r.action, 'wait_peers');
  }

  chrome._sentTabMessages.length = 0;
  const synthAg = room.agents[4];
  vm.runInContext(`TAB_STATES.get(${synthAg.tabId}).status = 'idle'`, ctx);
  const resSynthR1 = await chrome._dispatchMessage(
    {
      type: 'AU_COLLAB_TURN_COMPLETED',
      payload: {
        roomId,
        bindingEpoch: synthAg.bindingEpoch,
        assistantText:
          '[TEMPCHAT] @Todos Sou @Agente5 (Líder Integrador), coordeno a integração de @Agente1..@Agente4! [/TEMPCHAT]\n[ENTREGA_FINAL_PRONTA]\nTentativa prematura na Rodada 1'
      }
    },
    { tab: { id: synthAg.tabId } }
  );
  // Premature Round-1 close must be blocked AND Agent 5 immediately receives all 4 peers' Round-1 messages!
  assert.equal(room.status, 'active', 'Multi-agent room must NEVER close prematurely on Round 1');
  assert.equal(resSynthR1.action, 'send_collab_prompt');
  assert.equal(resSynthR1.unreadCount, 4, 'Agent 5 must see all 4 teammates from Round 1');

  // Verify instant wake-up pulse was dispatched to waiting peer Agent 1 (tab 501)!
  const woke501 = chrome._sentTabMessages.some(
    (m) => m.tabId === 501 && m.msg && m.msg.type === 'AU_HEARTBEAT_TICK' && m.msg.wakeCollabPeers === true
  );
  assert.equal(woke501, true, 'Completing the Round-1 barrier must immediately pulse waiting peer tabs');
  const notices = chrome._sentTabMessages.filter(m => m.msg && m.msg.type === 'AU_ROOM_MESSAGE_NOTIFICATION');
  assert.ok(notices.length > 0, 'Room messages must notify peers');
  assert.ok(notices.every(m => String(m.msg.roomId) === String(roomId)), 'Notices must remain in their room');
  assert.ok(notices.every(m => [501,502,503,504,505].includes(m.tabId)), 'Only admitted room tabs receive notices');
  assert.ok(notices.every(m => m.msg.seq > 0 && m.msg.bindingEpoch > 0));


  // 4. Now Agent 1 wakes up and advances to Round 2 -> receives ALL 4 teammates' Round-1 messages & compact CLI!
  const resAg1Round2 = await chrome._dispatchMessage(
    {
      type: 'AU_COLLAB_TURN_COMPLETED',
      payload: {
        roomId,
        bindingEpoch: room.agents[0].bindingEpoch,
        assistantText: '[TEMPCHAT] @Todos Sou @Agente1, assumo `src/core/*`. @Agente2 pode assumir `src/ui/*`? [/TEMPCHAT]'
      }
    },
    { tab: { id: 501 } }
  );
  assert.equal(resAg1Round2.action, 'send_collab_prompt');
  assert.equal(resAg1Round2.unreadCount, 4, 'Agent 1 must receive 100% of all 4 teammates Round-1 messages');
  assert.match(resAg1Round2.prompt, /@Agente2/);
  assert.match(resAg1Round2.prompt, /@Agente3/);
  assert.match(resAg1Round2.prompt, /@Agente4/);
  assert.match(resAg1Round2.prompt, /@Agente5/);
  assert.equal(resAg1Round2.prompt.includes('#!/usr/bin/env python3'), false, 'Round-2 prompt must use compact CLI reminder');
});

// ============================================================================
// A28 — v4.1.0: Real Python /tmp/au_chat claim, ask, reply & sync Execution
// ============================================================================
test('A28 (v4.1.0): Real Python /tmp/au_chat claim, ask, reply & sync coordinates roles and highlights 🎯[PARA VOCÊ]', async () => {
  const { ctx } = loadSharedContext();
  const roomHmacKey = ctx.AU_CRED_BROKER.generateRoomHmacKeyHex();

  const shAg1 = ctx.AU_COLLAB.buildRealtimeChatInstructions({
    roomId: '9028',
    filebinId: 'bin9028',
    agentIndex: 1,
    agentName: 'Agente 1 • Arquiteto',
    roleTitle: 'Arquiteto',
    roomHmacKey
  });
  const shAg2 = ctx.AU_COLLAB.buildRealtimeChatInstructions({
    roomId: '9028',
    filebinId: 'bin9028',
    agentIndex: 2,
    agentName: 'Agente 2 • Frontend',
    roleTitle: 'Frontend',
    roomHmacKey
  });

  const pyAg1 = extractHeredocScript(shAg1, '/tmp/au_chat');
  const pyAg2 = extractHeredocScript(shAg2, '/tmp/au_chat');

  const bucket = new Map();
  bucket.set(
    'au_board_state.json',
    JSON.stringify({
      rev: 2,
      integration: { stateLabel: 'Alinhando', remainingLabel: '24m', readyCount: 0, expectedCount: 2 },
      assignments: {
        ag1: { status: 'em_progresso', agentName: 'Agente 1 • Arquiteto', files: 'src/core/*', notes: 'Motor core' }
      },
      contracts: {}
    })
  );

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/bin9028') {
      const files = [...bucket.keys()].map((filename) => ({ filename }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
      return;
    }
    const mFile = req.url.match(/^\/bin9028\/([^/?#]+)$/);
    if (mFile && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        bucket.set(mFile[1], body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    if (mFile && req.method === 'GET' && bucket.has(mFile[1])) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(bucket.get(mFile[1]));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-team-cli-'));
  const stateDir = path.join(tmpDir, 'au_state');
  const ag1Path = path.join(tmpDir, 'au_chat_ag1.py');
  const ag2Path = path.join(tmpDir, 'au_chat_ag2.py');
  const cleanEnv = {
    ...process.env,
    AU_STATE_DIR: stateDir,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: '',
    http_proxy: ''
  };

  try {
    fs.writeFileSync(ag1Path, pyAg1.replaceAll('https://filebin.net', `http://127.0.0.1:${port}`), { mode: 0o755 });
    fs.writeFileSync(ag2Path, pyAg2.replaceAll('https://filebin.net', `http://127.0.0.1:${port}`), { mode: 0o755 });

    // Agent 1 claims exclusive files & asks @Agente2 a direct question
    await execFileAsync('python3', [ag1Path, 'claim', 'src/core/*', 'Motor de regras'], { env: cleanEnv });
    await execFileAsync('python3', [ag1Path, 'ask', '@[Agente 2 • Frontend]', 'Prefere REST ou Eventos para o estado da UI?'], {
      env: cleanEnv
    });
    assert.equal(bucket.has('auboard_assign_ag1.json'), true, 'claim must update single-assignment board slot');

    // Agent 2 runs `sync` -> sees Role Map + both messages from Agent 1 with 🎯[PARA VOCÊ] highlight!
    const { stdout: syncOut } = await execFileAsync('python3', [ag2Path, 'sync'], { env: cleanEnv, encoding: 'utf8' });
    assert.match(syncOut, /🔔 NOTIFICAÇÃO: 2/);
    assert.match(syncOut, /QUEM FAZ O QUÊ/);
    assert.match(syncOut, /DIVISÃO DE PAPEL/);
    assert.match(syncOut, /🎯\[PARA VOCÊ\]/);
    assert.match(syncOut, /Prefere REST ou Eventos/);

    // Agent 2 replies directly to @Agente1, and Agent 1 reads it tagged 🎯[PARA VOCÊ]!
    await execFileAsync('python3', [ag2Path, 'reply', '@[Agente 1 • Arquiteto]', 'Fechado em Eventos tipados, assumo src/ui/*!'], {
      env: cleanEnv
    });
    const { stdout: ag1Read } = await execFileAsync('python3', [ag1Path, 'read'], { env: cleanEnv, encoding: 'utf8' });
    assert.match(ag1Read, /🎯\[PARA VOCÊ\]/);
    assert.match(ag1Read, /Fechado em Eventos tipados/);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});



test('A29: timer real persistente preserva ciclo ativo, reconhece vencimento e isola sala/agente', async () => {
  const { ctx } = loadSharedContext();
  const block = ctx.AU_COLLAB.buildSessionTimerInstructions({ roomId: 'timer-room', agentIndex: 2, sessionTimerMinutes: 120 });
  const script = extractHeredocScript(block, '/tmp/au_timer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-timer-test-'));
  const py = path.join(dir, 'timer.py'); fs.writeFileSync(py, script);
  const env = { ...process.env, AU_STATE_DIR: dir };
  try {
    const first = await execFileAsync('python3', [py, 'start', '120'], { env });
    assert.match(first.stdout, /CAN_FINISH=NO/);
    const stateFile = path.join(dir, 'au_timer_timer-room_ag2.json');
    const original = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(original.targetSec, 7200);
    await execFileAsync('python3', [py, 'start', '60'], { env });
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).startedAt, original.startedAt);
    original.startedAt = Date.now()/1000 - 7300;
    fs.writeFileSync(stateFile, JSON.stringify(original));
    const expired = await execFileAsync('python3', [py, 'check'], { env });
    assert.match(expired.stdout, /CAN_FINISH=YES/);
    const renewed = await execFileAsync('python3', [py, 'start', '60'], { env });
    assert.match(renewed.stdout, /CAN_FINISH=NO/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A30: continuação não cresce com histórico, quadro ou briefing e não repete instalador', () => {
  const { ctx } = loadSharedContext();
  for (const round of [2, 10, 100]) {
    const prompt = ctx.AU_COLLAB.buildNextCollabTurnPrompt({ roundNumber: round,
      codebaseBriefing: 'x'.repeat(100000), sessionTimerMinutes: 120,
      unreadMessages: Array.from({length: 100}, (_, i) => ({ senderType: 'agent', senderName: `Agente ${i+1}`, text: '@Todos ' + 'y'.repeat(5000) })) });
    assert.ok(prompt.length <= 2000);
    assert.equal(prompt.includes('#!/usr/bin/env python3'), false);
    assert.match(prompt, /au_timer check/);
    assert.match(prompt, /2 horas/);
  }
});

test('A31: @nomes exatos, espaços, caracteres especiais e índices não colidem', () => {
  const { ctx } = loadSharedContext();
  const mention = ctx.AU_COLLAB.isAgentMentioned;
  assert.equal(mention('@[Claude Sonnet] revise isto', 2, 'Claude Sonnet', 'QA'), true);
  assert.equal(mention('@Claude Sonnet revise isto', 2, 'Claude Sonnet', 'QA'), true);
  assert.equal(mention('@[claude sonnet] revise isto', 2, 'Claude Sonnet', 'QA'), true);
  assert.equal(mention('@[GPT (QA)+] revise', 2, 'GPT (QA)+', 'QA'), true);
  assert.equal(mention('@Agente20 oi', 2, 'Claude Sonnet', 'QA'), false);
  assert.equal(mention('@[Claude Sonnet Extra] oi', 2, 'Claude Sonnet', 'QA'), false);
  assert.equal(mention('@Todos oi', 2, 'Claude Sonnet', 'QA'), true);
  const hits = ctx.AU_COLLAB.extractDirectMentionsForAgent([{senderName:'Colega',text:'@[Claude Sonnet] implemente o contrato'}], 2, 'Claude Sonnet', 'QA');
  assert.equal(hits[0].directMention, true);
});

test('A32: fila de agentes usa 300–750ms por mensagem, FIFO por sala e humano passa imediatamente', async () => {
  const { ctx } = loadSharedContext({ loadServiceWorker: true });
  const waits = [];
  ctx.testDelayCapture = waits;
  vm.runInContext('sleep = (ms) => new Promise(resolve => testDelayCapture.push({ ms, resolve }));', ctx);
  const room = { roomId: 'delay32', agents: [], messages: [], seq: 0 };
  const first = ctx.appendRoomMessage(room, { senderType:'agent', senderName:'A', text:'Primeira fala' });
  const second = ctx.appendRoomMessage(room, { senderType:'agent', senderName:'B', text:'Segunda fala' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waits.length, 1, 'Only first agent enters delay; second remains queued');
  assert.equal(room.messages.length, 0);
  const human = await ctx.appendRoomMessage(room, { senderType:'user', senderName:'Você', text:'Orientação urgente' });
  assert.equal(human.seq, 1);
  assert.equal(waits.length, 1, 'Human never schedules a delay');
  assert.ok(waits[0].ms >= 300 && waits[0].ms <= 750);
  waits[0].resolve(); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waits.length, 2);
  assert.ok(waits[1].ms >= 300 && waits[1].ms <= 750);
  waits[1].resolve(); await second;
  assert.deepEqual(Array.from(room.messages, m => m.senderName), ['Você','A','B']);
});

test('A33: harness bloqueia declaração vazia, revisão própria, epoch antigo e revisão obsoleta', () => {
  const { ctx } = loadSharedContext(); const h = ctx.AU_HARNESS;
  const agents = [{index:0,bindingEpoch:2}, {index:1,bindingEpoch:1}];
  const room = {roomId:'h33',agents,harness:h.fresh()};
  assert.equal(h.gate(room).ok, false);
  const report = (slot,epoch,revision,reviews=[]) => '[HARNESS_REPORT]'+JSON.stringify({
    roomId:'h33',slot,epoch,revision,complete:true,taskCount:1,
    evidence:[{task:'feature',exitCode:0,revision,digest:'a'.repeat(64)}],reviews
  })+'[/HARNESS_REPORT]';
  h.observe(room,agents[0],report('ag1',1,1));
  assert.equal(Object.keys(room.harness.reports).length,0);
  h.observe(room,agents[0],report('ag2',2,1));
  assert.equal(Object.keys(room.harness.reports).length,0);
  h.observe(room,agents[0],report('ag1',2,1,[{target:'ag1',revision:1,decision:'accept'}]));
  h.observe(room,agents[1],report('ag2',1,1));
  assert.equal(h.gate(room).ok,false);
  h.observe(room,agents[0],report('ag1',2,1,[{target:'ag2',revision:1,decision:'accept'}]));
  h.observe(room,agents[1],report('ag2',1,1,[{target:'ag1',revision:1,decision:'accept'}]));
  assert.equal(h.gate(room).ok,true);
  const restored = JSON.parse(JSON.stringify(room));
  assert.equal(h.gate(restored).ok,true,'Checkpoint survives JSON persistence');
  h.observe(room,agents[0],report('ag1',2,2,[{target:'ag2',revision:1,decision:'accept'}]));
  assert.equal(h.gate(room).ok,false,'Changed revision invalidates peer review');
  h.observe(room,agents[1],report('ag2',1,1,[{target:'ag1',revision:2,decision:'reject'}]));
  assert.equal(h.gate(room).ok,false);
  assert.equal(h.cleanReports('[HARNESS_REPORT]{invalid[/HARNESS_REPORT]','h33','ag1',2).length,0);
  assert.equal(h.cleanReports(report('ag1',2,2),'other-room','ag1',2).length,0);
});

test('A34: harness Python executa validação real, falhas, retomada, checkpoint e rebind', async () => {
  const {ctx} = loadSharedContext();
  const block = ctx.AU_HARNESS.bootstrap({roomId:'h34',agentIndex:1,epoch:1,mode:'specialists'});
  const script = extractHeredocScript(block,'/home/user/au_state/harness-cli.py');
  assert.equal(script.trimEnd(),fs.readFileSync(path.join(ROOT,'shared/harness-cli.py'),'utf8').trimEnd());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'au-harness-'));
  const scopeDir = path.join(dir,'harness','h34_ag1'); fs.mkdirSync(scopeDir,{recursive:true});
  fs.writeFileSync(path.join(scopeDir,'config.json'),JSON.stringify({roomId:'h34',slot:'ag1',epoch:1}));
  const py = path.join(dir,'harness.py'); fs.writeFileSync(py,script);
  const env = {...process.env,AU_STATE_DIR:dir,AU_HARNESS_SCOPE:'h34_ag1'};
  const run = async (...args) => (await execFileAsync('python3',[py,...args],{env})).stdout;
  const report = async () => ctx.AU_HARNESS.cleanReports(await run('report'),'h34','ag1',1)[0];
  try {
    await run('task','feature','functional acceptance');
    await run('verify','feature','--','python3','-c','raise SystemExit(3)');
    assert.equal((await report()).complete,false);
    await run('verify','feature','--','python3','-c','print("actual test")');
    const passed = await report(); assert.equal(passed.complete,true); assert.equal(passed.evidence.length,1);
    const state = JSON.parse(await run('resume')); assert.equal(state.tasks.feature.status,'passed');
    await run('checkpoint','Continue regression');
    assert.equal((await report()).evidence.length,0,'Checkpoint invalidates prior evidence');
    await run('bind','2');
    const rebound = ctx.AU_HARNESS.cleanReports(await run('report'),'h34','ag1',2)[0];
    assert.equal(rebound.complete,false); assert.equal(rebound.epoch,2);
    await assert.rejects(run('review','ag1','1','accept'));
    assert.equal(fs.existsSync(path.join(scopeDir,'checkpoint.json')),true);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('A35: todos os perfis têm política própria e continuação cabe em 2000 sem reinstalar', () => {
  const {ctx} = loadSharedContext();
  for (const mode of ['fixed','queue','conditional','hybrid','specialists','parallel_leader','debate_consensus']) {
    assert.ok(ctx.AU_HARNESS.POLICIES[mode]);
    assert.ok(ctx.AU_HARNESS.continuation(mode).length < 400);
  }
  const prompt=ctx.AU_COLLAB.buildNextCollabTurnPrompt({roomId:'35',harnessHint:'x'.repeat(480),sessionTimerMinutes:120,
    unreadMessages:Array.from({length:50},(_,i)=>({senderType:'user',senderName:'Human',text:'y'.repeat(1000)}))});
  assert.ok(prompt.length<=2000); assert.match(prompt,/au_timer check/);
  assert.equal(prompt.includes('cat <<'),false);
  assert.equal(ctx.AU_COLLAB.sanitizeConciseTeamMessage('Oi [HARNESS_REPORT]{"x":1}[/HARNESS_REPORT] colega').includes('HARNESS_REPORT'),false);
});

test('A36: service worker impede fechamento sem harness e libera com evidências e revisão cruzada', async () => {
  const {ctx,chrome} = loadSharedContext({loadServiceWorker:true});
  vm.runInContext('sleep = async () => {};',ctx);
  for (const id of [801,802]) chrome._openTabs.set(id,{id,url:`https://arena.ai/c/harness-${id}`,title:'Harness test',windowId:1});
  const created = await ctx.createCollabRoomFromOpenTabs({baseTask:'Sistema verificável',profile:'specialists',stopMode:'smart_consensus',refuseThinkingModels:false});
  const room=vm.runInContext(`COLLAB_ROOMS.get(${JSON.stringify(created.roomId)})`,ctx);
  assert.ok(room.harness);
  for(const a of room.agents) {
    a.turnsCount=2; a.admittedToTeam=true; a.waitingSince=0;
    vm.runInContext(`TAB_STATES.set(${a.tabId},{tabId:${a.tabId},status:'idle',autoContinueEnabled:true,collabRoomId:${JSON.stringify(room.roomId)}})`,ctx);
    room.messages.push({seq:++room.seq,senderType:'agent',tabId:a.tabId,text:'Trabalho e testes concluídos',senderName:a.name});
  }
  const leader=room.agents.find(a=>a.isSynthesizer);
  const send = text => chrome._dispatchMessage({type:'AU_COLLAB_TURN_COMPLETED',payload:{roomId:room.roomId,bindingEpoch:leader.bindingEpoch,assistantText:text}},{tab:{id:leader.tabId}});
  const blocked = await send('[TEMPCHAT] Integrei a primeira revisão [/TEMPCHAT]\n[ENTREGA_FINAL_PRONTA] Entrega preliminar.');
  assert.notEqual(blocked.action,'stop_completed'); assert.equal(room.status,'active');
  for(const a of room.agents) {
    const slot=`ag${a.index+1}`, other=room.agents.find(b=>b!==a);
    const raw='[HARNESS_REPORT]'+JSON.stringify({roomId:room.roomId,slot,epoch:a.bindingEpoch,revision:1,complete:true,taskCount:1,
      evidence:[{task:'feature',revision:1,exitCode:0,digest:'b'.repeat(64)}],reviews:[{target:`ag${other.index+1}`,revision:1,decision:'accept'}]})+'[/HARNESS_REPORT]';
    ctx.AU_HARNESS.observe(room,a,raw);
  }
  assert.equal(ctx.AU_HARNESS.gate(room).ok,true);
  const done=await send('[TEMPCHAT] Revisão cruzada concluída [/TEMPCHAT]\n[ENTREGA_FINAL_PRONTA] Entrega validada por todos.');
  assert.equal(done.action,'stop_completed'); assert.equal(room.status,'completed');
});

test('A37: Agent Kit reduz bootstrap, preserva objetivo e nunca codifica PAT no descritor', () => {
  const {ctx}=loadSharedContext();
  const roles=ctx.AU_COLLAB.buildTeamRoles(5,'specialists');
  const params={roomId:'3737',basePrompt:'Construir app modular com login real.',agentRole:roles[0],teamRoles:roles,
    profile:'specialists',roomHmacKey:'a'.repeat(64),tempFileConfig:{enabled:true,filebinId:'au3737_bin'},sessionTimerMinutes:120,
    githubConfig:{enabled:true,repo:'nadabgfccvd/My-Path',filebinId:'au3737_bin',agentVaultCap:'scoped-room-cap',hasVaultCredential:true,token:'ghp_SENTINEL_TEST_DO_NOT_SEND_1234567890'}};
  const native=ctx.AU_COLLAB.buildInitialAgentPrompt(params);
  const compact=ctx.AU_COLLAB.buildInitialAgentPrompt({...params,agentKitEnabled:true});
  assert.ok(compact.length<native.length/2,`${compact.length} vs ${native.length}`);
  assert.equal(compact.includes('cat <<'),false);
  assert.match(compact,/sha256sum -c -/);
  assert.match(compact,/Construir app modular com login real/);
  const payload=compact.match(/--session-b64 '([A-Za-z0-9+/=]+)'/)[1];
  const cfg=JSON.parse(Buffer.from(payload,'base64').toString('utf8'));
  assert.equal(cfg.protocol,1);assert.equal(cfg.timerMinutes,120);assert.equal(cfg.agentIndex,1);
  assert.equal(cfg.github.repo,'nadabgfccvd/My-Path');assert.equal(cfg.github.cap,'scoped-room-cap');
  assert.equal(JSON.stringify(cfg).includes('ghp_'),false);
  assert.equal(cfg.allowUploads,false);
  assert.equal(ctx.AU_DEFAULTS.extractCleanObjectiveFromAutoPrompt(compact),'Construir app modular com login real.');
});

test('A38: handshake Agent Kit respeita sala, slot, epoch e protocolo; marcador não polui chat', () => {
  const {ctx}=loadSharedContext();
  const room={roomId:'38'},agent={index:1,bindingEpoch:4};
  const marker=v=>'[AU_AGENT_READY]'+JSON.stringify(v)+'[/AU_AGENT_READY]';
  const valid={roomId:'38',slot:'ag2',epoch:4,version:'1.0.0',protocol:1};
  ctx.AU_AGENT_KIT.observe(room,agent,marker({...valid,roomId:'other'}));assert.equal(agent.agentKit,undefined);
  ctx.AU_AGENT_KIT.observe(room,agent,marker({...valid,slot:'ag3'}));assert.equal(agent.agentKit,undefined);
  ctx.AU_AGENT_KIT.observe(room,agent,marker({...valid,epoch:3}));assert.equal(agent.agentKit,undefined);
  ctx.AU_AGENT_KIT.observe(room,agent,marker({...valid,protocol:2}));assert.equal(agent.agentKit.compatible,false);
  ctx.AU_AGENT_KIT.observe(room,agent,marker(valid));assert.equal(agent.agentKit.compatible,true);
  assert.equal(ctx.AU_COLLAB.sanitizeConciseTeamMessage('Oi '+marker(valid)).includes('AU_AGENT_READY'),false);
});

test('A39: nova sala com Agent Kit usa bootstrap compacto e registra capacidade declarada', async () => {
  const {ctx,chrome}=loadSharedContext({loadServiceWorker:true});
  await ctx.AU_STORAGE.saveSettings({agentKitEnabled:true});
  for(const id of [901,902])chrome._openTabs.set(id,{id,url:`https://arena.ai/c/kit-${id}`,title:'Kit agent',windowId:1});
  const created=await ctx.createCollabRoomFromOpenTabs({baseTask:'Criar módulo testado',profile:'parallel_leader',refuseThinkingModels:false});
  const room=vm.runInContext(`COLLAB_ROOMS.get(${JSON.stringify(created.roomId)})`,ctx);
  assert.equal(room.agentKitEnabled,true);
  const delivery=chrome._sentTabMessages.find(v=>v.msg && v.msg.payload && String(v.msg.payload.kickoffPrompt || '').includes('AGENT KIT'));
  const kickoff=delivery && delivery.msg.payload.kickoffPrompt;
  assert.ok(kickoff);assert.match(kickoff,/sha256sum/);assert.equal(kickoff.includes('cat <<'),false);
});
