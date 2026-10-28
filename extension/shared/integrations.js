(function (global) {
  'use strict';

  const PROVIDER_ORDER = ['filebin', 'litterbox', 'uguu', 'x0at'];

  function scrubSecrets(input, explicitToken) {
    let out = String(input || '');
    if (!out) return out;
    if (explicitToken && String(explicitToken).trim().length >= 8) {
      const tok = String(explicitToken).trim();
      out = out.split(tok).join('[GITHUB_TOKEN_PROTEGIDO]');
    }
    if (global.AU_CRED_BROKER && typeof global.AU_CRED_BROKER.scrubTextSecrets === 'function') {
      out = global.AU_CRED_BROKER.scrubTextSecrets(out, explicitToken ? [explicitToken] : []);
    }
    out = out
      .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}\b/g, '[GITHUB_TOKEN_PROTEGIDO]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, '[GITHUB_TOKEN_PROTEGIDO]')
      .replace(/\bTEST_SECRET_DO_NOT_USE_[A-Za-z0-9_]*\b/g, '[SEGREDO_SENTINELA_BLOQUEADO]')
      .replace(/(https?:\/\/[^/\s:@]+:)([^@\s/]+)(@github\.com)/gi, '$1[GITHUB_TOKEN_PROTEGIDO]$3')
      .replace(/(Authorization:\s*(?:Bearer|token)\s+)[^\s"']+/gi, '$1[GITHUB_TOKEN_PROTEGIDO]');
    return out;
  }

  // ARENA-02: Strip internal reasoning (<details>, <thought>, <think>) before room/bucket publication
  function scrubReasoningBlocks(input) {
    if (!input) return { text: '', strippedCount: 0 };
    let strippedCount = 0;
    let out = String(input);
    const rxList = [
      /<details\b[^>]*>[\s\S]*?<\/details>/gi,
      /<(?:think|thought|antThinking)\b[^>]*>[\s\S]*?<\/(?:think|thought|antThinking)>/gi,
      /<arena-system-message>[\s\S]*?<\/arena-system-message>/gi
    ];
    for (let i = 0; i < rxList.length; i++) {
      out = out.replace(rxList[i], () => {
        strippedCount++;
        return '';
      });
    }
    return {
      text: out.replace(/\n{4,}/g, '\n\n\n').trim(),
      strippedCount
    };
  }

  function sanitizeFilename(name) {
    const clean = String(name || 'artefato.bin')
      .replace(/^.*[/\\]/, '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^_+/, '');
    return clean || 'artefato.bin';
  }

  // ARENA-18: Cryptographically unique per-room bucket ID
  function generateFilebinId(roomId) {
    let rand = '';
    if (global.AU_CRED_BROKER && typeof global.AU_CRED_BROKER.generateRandomHex === 'function') {
      rand = global.AU_CRED_BROKER.generateRandomHex(6);
    } else {
      rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    }
    const r = String(roomId || Math.floor(1000 + Math.random() * 9000)).replace(/[^A-Za-z0-9]/g, '');
    return `arenaultra-${r}-${rand}`.toLowerCase();
  }

  function uint8ToBase64(u8) {
    const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const sub = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoa(binary);
  }

  function base64ToUint8(b64) {
    const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return new Uint8Array(Buffer.from(clean, 'base64'));
    }
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function detectProviderFromUrl(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('filebin.net/')) return 'filebin';
    if (u.includes('catbox.moe/')) return 'litterbox';
    if (u.includes('uguu.se/')) return 'uguu';
    if (u.includes('x0.at/')) return 'x0at';
    return 'link';
  }

  // =========================================================================
  // 4-HOST TEMPORARY FILE HUB (Filebin.net + Litterbox + Uguu.se + x0.at)
  // =========================================================================
  async function uploadToProvider(providerId, rawBytes, filename, opts = {}) {
    const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
    const safeName = sanitizeFilename(filename);
    const mime = opts.mimeType || 'application/octet-stream';

    if (providerId === 'filebin') {
      const binId = opts.binId || generateFilebinId(opts.roomId || 'shared');
      const targetUrl = `https://filebin.net/${encodeURIComponent(binId)}/${encodeURIComponent(safeName)}`;
      const resp = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream',
          cid: 'arena-ultra'
        },
        body: bytes
      });
      if (!resp.ok) {
        throw new Error(`Filebin HTTP ${resp.status}`);
      }
      return {
        provider: 'filebin',
        providerLabel: 'Filebin.net',
        filename: safeName,
        sizeBytes: bytes.length,
        binId,
        binUrl: `https://filebin.net/${encodeURIComponent(binId)}`,
        url: targetUrl
      };
    }

    if (providerId === 'litterbox') {
      const expiry = ['1h', '12h', '24h', '72h'].includes(opts.expiry) ? opts.expiry : '24h';
      const fd = new FormData();
      fd.append('reqtype', 'fileupload');
      fd.append('time', expiry);
      fd.append('fileToUpload', new Blob([bytes], { type: mime }), safeName);
      const resp = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        body: fd
      });
      const text = (await resp.text()).trim();
      if (!resp.ok || !/^https?:\/\/\S+/i.test(text)) {
        throw new Error(`Litterbox falhou: ${text.slice(0, 90) || resp.status}`);
      }
      return {
        provider: 'litterbox',
        providerLabel: `Litterbox (${expiry})`,
        filename: safeName,
        sizeBytes: bytes.length,
        url: text
      };
    }

    if (providerId === 'uguu') {
      const fd = new FormData();
      fd.append('files[]', new Blob([bytes], { type: mime }), safeName);
      const resp = await fetch('https://uguu.se/upload', {
        method: 'POST',
        body: fd
      });
      const data = await resp.json();
      const fileUrl = data && data.success && Array.isArray(data.files) && data.files[0] && data.files[0].url;
      if (!resp.ok || !fileUrl) {
        throw new Error(`Uguu.se HTTP ${resp.status}`);
      }
      return {
        provider: 'uguu',
        providerLabel: 'Uguu.se',
        filename: safeName,
        sizeBytes: bytes.length,
        url: String(fileUrl).replace(/\\\//g, '/')
      };
    }

    if (providerId === 'x0at') {
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: mime }), safeName);
      const resp = await fetch('https://x0.at/', {
        method: 'POST',
        body: fd
      });
      const text = (await resp.text()).trim();
      if (!resp.ok || !/^https?:\/\/\S+/i.test(text)) {
        throw new Error(`x0.at falhou: ${text.slice(0, 90) || resp.status}`);
      }
      return {
        provider: 'x0at',
        providerLabel: 'x0.at',
        filename: safeName,
        sizeBytes: bytes.length,
        url: text
      };
    }

    throw new Error(`Provedor desconhecido: ${providerId}`);
  }

  async function uploadWithFallback(rawBytes, filename, opts = {}) {
    const primary = PROVIDER_ORDER.includes(opts.primaryProvider) ? opts.primaryProvider : 'filebin';
    const allowFallback = opts.autoFallback !== false;
    const sequence = allowFallback
      ? [primary, ...PROVIDER_ORDER.filter((p) => p !== primary)]
      : [primary];

    const errors = [];
    for (let i = 0; i < sequence.length; i++) {
      const prov = sequence[i];
      try {
        const res = await uploadToProvider(prov, rawBytes, filename, opts);
        return Object.assign({}, res, {
          ok: true,
          fallbackUsed: i > 0,
          attemptedProviders: sequence.slice(0, i + 1)
        });
      } catch (err) {
        errors.push(`${prov}: ${err.message || err}`);
      }
    }
    throw new Error(`Falha no upload temporário (${errors.join(' | ')})`);
  }

  async function listFilebinFiles(binId) {
    if (!binId) return [];
    try {
      const resp = await fetch(`https://filebin.net/${encodeURIComponent(binId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      if (!data || !Array.isArray(data.files)) return [];
      return data.files.map((f) => ({
        filename: f.filename,
        sizeBytes: Number(f.bytes || 0),
        provider: 'filebin',
        providerLabel: 'Filebin.net',
        binId,
        url: `https://filebin.net/${encodeURIComponent(binId)}/${encodeURIComponent(f.filename)}`,
        updatedAt: f.updated_at || ''
      }));
    } catch (_) {
      return [];
    }
  }

  async function fetchSharedFileBytes(url) {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) throw new Error('URL vazia');
    const isFilebin = /https?:\/\/(?:[^/]+\.)?filebin\.net\//i.test(cleanUrl);
    const headers = {};
    if (isFilebin) {
      headers.Accept = 'application/octet-stream, */*';
      headers.cid = 'arena-ultra';
    }
    const resp = await fetch(cleanUrl, {
      method: 'GET',
      headers,
      credentials:
        cleanUrl.includes('arena.ai') || cleanUrl.includes('lmarena.ai')
          ? 'include'
          : 'omit',
      redirect: 'follow'
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ao baixar ${cleanUrl}`);
    }
    const ab = await resp.arrayBuffer();
    return new Uint8Array(ab);
  }

  // =========================================================================
  // PURE-JS ZIP ARCHIVE EXTRACTOR (DecompressionStream('deflate-raw'))
  // =========================================================================
  async function inflateRawBytes(compSlice) {
    if (typeof global.__auNodeInflateRaw === 'function') {
      return new Uint8Array(global.__auNodeInflateRaw(compSlice));
    }
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compSlice]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    }
    throw new Error('DecompressionStream indisponível neste navegador.');
  }

  // DATA-03: Block universal cache dirs anywhere, but block `dist`/`build`/`target`/`out`/`coverage` ONLY at root (`parts[0]`)
  // so legitimate nested source paths such as `src/build/helper.ts` or `crates/app/src/target.rs` are NEVER dropped!
  function isExcludedZipPath(relPath, checkRootBuildDirs = true) {
    const p = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p || p.endsWith('/')) return true;
    const parts = p.split('/');
    const universalBlockedDirs = new Set([
      '.git',
      '.arena',
      '.local',
      '.npm',
      '.mypy_cache',
      '.ruff_cache',
      '.playwright-cli',
      'Unselected files',
      'node_modules',
      '__pycache__',
      '.venv',
      '.cache',
      '.pytest_cache',
      '.svelte-kit',
      '.turbo',
      '.vite',
      '.parcel-cache',
      'repo-wiki'
    ]);
    const rootOnlyBuildDirs = new Set(['dist', 'build', 'target', '.next', 'out', 'coverage']);

    if (checkRootBuildDirs && parts.length > 1 && rootOnlyBuildDirs.has(parts[0])) {
      return true;
    }
    for (let i = 0; i < parts.length - 1; i++) {
      if (universalBlockedDirs.has(parts[i])) return true;
    }
    const base = parts[parts.length - 1];
    if (
      base === '.DS_Store' ||
      base === '.gitconfig' ||
      base === '.git-credentials' ||
      base === '.netrc' ||
      base === '.bash_history' ||
      base === '.python_history' ||
      base === '.lesshst'
    ) {
      return true;
    }
    return false;
  }

  function detectGitModeFromZipEntry(externalAttrs, contentBytes, relPath) {
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) return '120000'; // Symlink (DATA-02)
    if ((unixMode & 0o111) !== 0) return '100755';       // Executable bit set (DATA-02)
    if (/\.(sh|bash)$/i.test(relPath || '') && contentBytes && contentBytes.length >= 2) {
      if (contentBytes[0] === 0x23 && contentBytes[1] === 0x21) return '100755'; // "#!" shebang
    }
    return '100644';
  }

  async function extractZipArchive(zipBytes, opts = {}) {
    const u8 = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
    if (u8.length < 22) throw new Error('Arquivo ZIP inválido ou vazio.');
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    let eocd = -1;
    const minSearch = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= minSearch; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Cabeçalho Central Directory do ZIP não encontrado.');

    const totalEntries = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');

    let pos = cdOffset;
    const rawEntries = [];
    for (let n = 0; n < totalEntries && pos + 46 <= u8.length; n++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const method = view.getUint16(pos + 10, true);
      const compSize = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const externalAttrs = view.getUint32(pos + 38, true);
      const localHeaderOffset = view.getUint32(pos + 42, true);
      const rawName = decoder.decode(u8.subarray(pos + 46, pos + 46 + nameLen)).replace(/\\/g, '/').replace(/^\/+/, '');
      pos += 46 + nameLen + extraLen + commentLen;

      if (!rawName || rawName.endsWith('/')) continue;
      if (method !== 0 && method !== 8) continue;

      const lhNameLen = view.getUint16(localHeaderOffset + 26, true);
      const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      const compSlice = u8.subarray(dataStart, dataStart + compSize);
      const contentBytes = method === 0 ? compSlice : await inflateRawBytes(compSlice);
      const gitMode = detectGitModeFromZipEntry(externalAttrs, contentBytes, rawName);
      rawEntries.push({ path: rawName, bytes: contentBytes, mode: gitMode });
    }

    // Filter universal junk BEFORE root-folder stripping
    let entries = rawEntries.filter((e) => !isExcludedZipPath(e.path, false));

    const PRESERVED_SOURCE_ROOTS = new Set([
      '.github',
      'src',
      'lib',
      'app',
      'docs',
      'public',
      'tests',
      'test',
      'scripts',
      'packages',
      'crates',
      'cmd',
      'pkg',
      'internal',
      'assets',
      'components',
      'pages',
      'server',
      'client',
      'config'
    ]);

    if (opts.stripSingleRoot !== false && entries.length > 0) {
      for (let depth = 0; depth < 4 && entries.length > 0; depth++) {
        const firstSegs = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : '')));
        if (firstSegs.size !== 1 || firstSegs.has('')) break;
        const seg = Array.from(firstSegs)[0];
        if (PRESERVED_SOURCE_ROOTS.has(seg)) break;
        if (seg === 'repo' && opts.preferRepoSubdir) break;
        const prefix = seg + '/';
        entries = entries
          .map((e) => ({ path: e.path.slice(prefix.length), bytes: e.bytes, mode: e.mode }))
          .filter((e) => Boolean(e.path) && !isExcludedZipPath(e.path, false));
      }
    }

    if (opts.preferRepoSubdir && entries.some((e) => e.path.startsWith('repo/'))) {
      entries = entries
        .filter((e) => e.path.startsWith('repo/'))
        .map((e) => ({ path: e.path.slice('repo/'.length), bytes: e.bytes, mode: e.mode }))
        .filter((e) => Boolean(e.path));
    }

    // Filter root-only build directories (`build/`, `dist/`, `target/`, `.next/`) while keeping `src/build/...`!
    entries = entries.filter((e) => !isExcludedZipPath(e.path, true));

    const maxFiles = Number(opts.maxFiles || 1500);
    const omitted = [];
    if (entries.length > maxFiles) {
      for (let i = maxFiles; i < entries.length; i++) {
        omitted.push({ path: entries[i].path, reason: 'max_files_limit' });
      }
    }
    const sliced = entries.slice(0, maxFiles);
    const meta = {
      status: omitted.length > 0 ? 'partial' : 'complete',
      truncated: omitted.length > 0,
      totalAfterFilter: entries.length,
      exportedCount: sliced.length,
      droppedCount: omitted.length,
      omitted
    };
    Object.defineProperty(sliced, 'meta', { value: meta, enumerable: false });
    Object.defineProperty(sliced, 'truncated', { value: meta.truncated, enumerable: false });
    Object.defineProperty(sliced, 'status', { value: meta.status, enumerable: false });
    Object.defineProperty(sliced, 'omitted', { value: omitted, enumerable: false });
    return sliced;
  }

  // =========================================================================
  // GITHUB LINK / SLUG PARSER + REST & GIT DATA API CLIENT
  // =========================================================================
  const GITHUB_RESERVED_OWNERS = new Set([
    'settings',
    'notifications',
    'login',
    'signup',
    'session',
    'explore',
    'Topics',
    'topics',
    'trending',
    'collections',
    'events',
    'sponsors',
    'marketplace',
    'pulls',
    'issues',
    'codespaces',
    'features',
    'pricing',
    'about',
    'new',
    'organizations'
  ]);

  function normalizeGithubToken(rawToken) {
    let clean = String(rawToken || '').trim();
    if (!clean) return '';
    clean = clean
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^(Bearer|token)\s+/i, '')
      .trim();
    return clean;
  }

  const QUICK_GITHUB_TOKEN_URL =
    'https://github.com/settings/tokens/new?scopes=repo,workflow,project&description=Arena+Ultra+Autonomous+PR';

  function parseGitRepoSpec(rawInput, fallbackOwner) {
    let raw = String(rawInput || '').trim();
    if (!raw) return null;

    // Extract URL if pasted as Markdown link [Code](https://github.com/...) or multi-line GitHub navbar or embedded URL in text
    const mdAll = Array.from(raw.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi));
    const ghMd = mdAll.find((m) => /github\.com\/[^/\s]+\/[^/\s]+/i.test(m[1]));
    if (ghMd && ghMd[1]) {
      raw = ghMd[1].trim();
    } else if (mdAll.length > 0 && mdAll[0][1]) {
      raw = mdAll[0][1].trim();
    } else if (/\s/.test(raw)) {
      const embeddedUrl = raw.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s)"'<>]+/i);
      if (embeddedUrl && embeddedUrl[0]) raw = embeddedUrl[0].trim();
    }
    raw = raw.replace(/^<+|>$/g, '').replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!raw) return null;

    let embeddedToken = '';
    let branchFromUrl = '';
    let host = 'github.com';
    let pathPart = '';

    // 1. SSH URL: git@github.com:owner/repo.git or ssh://git@github.com/owner/repo.git
    const scpMatch = raw.match(/^(?:ssh:\/\/)?git@([^:/\s]+)[:/](.+)$/i);
    if (scpMatch) {
      host = String(scpMatch[1] || 'github.com').toLowerCase().replace(/^www\./, '');
      pathPart = String(scpMatch[2] || '').split(/[?#]/)[0];
    } else if (/^https?:\/\//i.test(raw) || /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|gitea\.com)\//i.test(raw)) {
      // 2. Full HTTP(S) URL or schemeless domain link (github.com/owner/repo...)
      const normalizedUrlStr = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
        const u = new URL(normalizedUrlStr);
        host = String(u.hostname || 'github.com').toLowerCase().replace(/^www\./, '');
        const decPart = (s) => {
          try {
            return decodeURIComponent(String(s || ''));
          } catch (_) {
            return String(s || '');
          }
        };
        if (u.password) {
          embeddedToken = decPart(u.password);
        } else if (
          u.username &&
          !/^(git|x-access-token|oauth2|token)$/i.test(decPart(u.username))
        ) {
          embeddedToken = decPart(u.username);
        }
        pathPart = u.pathname || '';
      } catch (_) {
        pathPart = raw.replace(/^https?:\/\/[^/]+\//i, '');
      }
    } else {
      // 3. owner/repo, owner/repo.git, owner/repo/tree/branch, or bare repo name
      pathPart = raw.split(/[?#]/)[0];
    }

    pathPart = String(pathPart || '').replace(/^\/+|\/+$/g, '');
    if (!pathPart) return null;

    const rawSegs = pathPart.split('/').filter(Boolean);
    if (!rawSegs.length) return null;

    const isGithub = host === 'github.com' || host.endsWith('.github.com');

    function safeDecode(s) {
      try {
        return decodeURIComponent(String(s || ''));
      } catch (_) {
        return String(s || '');
      }
    }

    if (isGithub) {
      let owner = '';
      let repo = '';
      if (rawSegs.length >= 2) {
        if (rawSegs[0].toLowerCase() === 'orgs' && rawSegs.length < 4) {
          return null;
        }
        owner = safeDecode(rawSegs[0]);
        repo = safeDecode(rawSegs[1]).replace(/\.git$/i, '');
        if (GITHUB_RESERVED_OWNERS.has(owner) || GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) {
          return null;
        }
        const subRoute = (rawSegs[2] || '').toLowerCase();
        if ((subRoute === 'tree' || subRoute === 'blob' || subRoute === 'commits') && rawSegs[3]) {
          branchFromUrl =
            subRoute === 'tree' && rawSegs.length >= 4
              ? rawSegs.slice(3).map((s) => safeDecode(s)).join('/')
              : safeDecode(rawSegs[3]);
        }
      } else if (fallbackOwner) {
        owner = String(fallbackOwner).trim();
        repo = safeDecode(rawSegs[0]).replace(/\.git$/i, '');
      } else {
        return null;
      }

      if (!owner || !repo || repo === 'repositories') return null;
      const fullName = `${owner}/${repo}`;
      return {
        owner,
        repo,
        fullName,
        host: 'github.com',
        isGithub: true,
        webUrl: `https://github.com/${owner}/${repo}`,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        branchFromUrl,
        embeddedToken: normalizeGithubToken(embeddedToken)
      };
    }

    // Generic Git host (GitLab, Bitbucket, Gitea, Enterprise Git...)
    if (rawSegs.length < 2) return null;
    const cleanSegs = rawSegs.map((s) => safeDecode(s));
    const dashIdx = cleanSegs.indexOf('-');
    const repoSegs = dashIdx >= 2 ? cleanSegs.slice(0, dashIdx) : cleanSegs.slice(0, 2);
    if (dashIdx >= 2 && (cleanSegs[dashIdx + 1] === 'tree' || cleanSegs[dashIdx + 1] === 'blob') && cleanSegs[dashIdx + 2]) {
      branchFromUrl = cleanSegs[dashIdx + 2];
    }
    const lastIdx = repoSegs.length - 1;
    repoSegs[lastIdx] = repoSegs[lastIdx].replace(/\.git$/i, '');
    const owner = repoSegs.slice(0, -1).join('/');
    const repo = repoSegs[lastIdx];
    const fullName = `${owner}/${repo}`;
    return {
      owner,
      repo,
      fullName,
      host,
      isGithub: false,
      webUrl: `https://${host}/${fullName}`,
      cloneUrl: `https://${host}/${fullName}.git`,
      branchFromUrl,
      embeddedToken: normalizeGithubToken(embeddedToken)
    };
  }

  function extractGithubRepoFromText(text) {
    const raw = String(text || '');
    if (!raw) return null;
    const matches = raw.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s)"'<>]*)?/gi);
    if (!matches) return null;
    for (const m of matches) {
      const spec = parseGitRepoSpec(m);
      if (spec && spec.isGithub) return spec;
    }
    return null;
  }

  function parseRepoFullName(repoStr, fallbackOwner) {
    return parseGitRepoSpec(repoStr, fallbackOwner);
  }

  function encodeRefSegments(refName) {
    return String(refName || '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  // SEC-04: Recommend Fine-Grained PAT first, keep Classic PAT helper + Revoke URL
  const FINE_GRAINED_GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
  const REVOKE_GITHUB_TOKEN_URL = 'https://github.com/settings/tokens';

  function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }

  async function ghRequest(token, endpoint, opts = {}) {
    const pat = normalizeGithubToken(token);
    const allowAnonymous = Boolean(opts.allowAnonymous);
    if (!pat && !allowAnonymous) {
      throw new Error(
        'Para enviar commits ou acessar repositórios privados, informe seu Token PAT do GitHub (para repositórios públicos de leitura/clone o token não é obrigatório).'
      );
    }
    const method = String(opts.method || 'GET').toUpperCase();
    const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
    const headers = Object.assign(
      {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      pat ? { Authorization: `Bearer ${pat}` } : {},
      opts.headers || {}
    );
    if (opts.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const serializedBody = opts.body
      ? typeof opts.body === 'string'
        ? opts.body
        : JSON.stringify(opts.body)
      : undefined;

    const maxRetries = opts.maxRetries !== undefined ? Number(opts.maxRetries) : 3;
    const baseDelayMs = opts.retryBaseDelayMs !== undefined ? Number(opts.retryBaseDelayMs) : 650;
    const repoMatch = String(endpoint || '').match(/^\/repos\/([^/]+\/[^/?#]+)/);
    const auditRepo = repoMatch ? decodeURIComponent(repoMatch[1]) : '';

    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let resp;
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: serializedBody
        });
      } catch (netErr) {
        // ARENA-17: On mutating write network failure after dispatch, mark uncertain outcome unless caller confirms idempotency
        const err = new Error(`Falha de rede ao contatar GitHub API (${netErr.message || netErr})`);
        err.errorKind = 'network_timeout';
        err.outcomeStatus = isMutating ? 'unknown' : 'rejected';
        err.operationId = opts.operationId || '';
        lastErr = err;
        if (!isMutating && attempt < maxRetries) {
          const jitter = Math.floor(Math.random() * 220);
          await sleepMs(baseDelayMs * Math.pow(2, attempt) + jitter);
          continue;
        }
        throw err;
      }

      const text = await resp.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = { raw: text };
      }

      if (resp.ok) {
        if (isMutating && global.AU_CRED_BROKER && typeof global.AU_CRED_BROKER.recordSecurityAudit === 'function') {
          global.AU_CRED_BROKER.recordSecurityAudit({
            category: 'github_api',
            action: method,
            endpoint: String(endpoint).slice(0, 140),
            repo: auditRepo,
            status: String(resp.status)
          });
        }
        return { data, headers: resp.headers, status: resp.status, outcomeStatus: 'accepted' };
      }

      const rawApiMsg = String((data && data.message) || `GitHub HTTP ${resp.status}`);
      const retryAfterHeader = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
      const rlRemaining = resp.headers && resp.headers.get ? resp.headers.get('x-ratelimit-remaining') : null;
      const rlResetSec = resp.headers && resp.headers.get ? Number(resp.headers.get('x-ratelimit-reset') || 0) : 0;

      const isRateLimit =
        resp.status === 429 ||
        (resp.status === 403 &&
          (retryAfterHeader !== null ||
            rlRemaining === '0' ||
            /rate limit|secondary rate limit|abuse detection/i.test(rawApiMsg)));
      const isTransient5xx = resp.status === 502 || resp.status === 503 || resp.status === 504;

      if ((isRateLimit || (isTransient5xx && !isMutating)) && attempt < maxRetries) {
        let waitMs = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        if (retryAfterHeader) {
          const sec = parseFloat(retryAfterHeader);
          if (Number.isFinite(sec) && sec > 0) {
            waitMs = Math.min(12000, Math.ceil(sec * 1000) + 150);
          }
        } else if (rlRemaining === '0' && rlResetSec > 0) {
          const untilReset = rlResetSec * 1000 - Date.now();
          if (untilReset > 0 && untilReset <= 12000) {
            waitMs = untilReset + 150;
          }
        }
        await sleepMs(opts.retryMaxWaitMs !== undefined ? Math.min(opts.retryMaxWaitMs, waitMs) : waitMs);
        continue;
      }

      let msg = rawApiMsg;
      let errorKind = 'api_error';
      if (isRateLimit) {
        errorKind = 'rate_limit';
        const resetLabel = rlResetSec > 0 ? ` (reset às ${new Date(rlResetSec * 1000).toLocaleTimeString('pt-BR')})` : '';
        msg = `Limite de requisições da API do GitHub atingido${resetLabel}: ${rawApiMsg}`;
      } else if (resp.status === 404 && !pat) {
        errorKind = 'auth_required';
        msg =
          'Repositório privado ou link não encontrado. Se este repositório for PRIVADO, cole seu Token PAT do GitHub (github_pat_... ou ghp_...) no Cofre para liberar o acesso!';
      } else if (resp.status === 401 && pat) {
        errorKind = 'auth_invalid';
        msg = 'Token PAT do GitHub inválido, expirado ou revogado (HTTP 401). Gere ou atualize um Token válido no Cofre.';
      } else if ((resp.status === 403 || resp.status === 404) && pat && endpoint.startsWith('/repos/')) {
        errorKind = 'insufficient_scope';
        msg = `${rawApiMsg} — Permissão/escopo insuficiente no Token PAT (habilite "Contents: Read and write" + "Pull requests: Read and write" no Fine-Grained PAT, ou escopo "repo" no Classic PAT).`;
      }

      if (global.AU_CRED_BROKER && typeof global.AU_CRED_BROKER.recordSecurityAudit === 'function') {
        global.AU_CRED_BROKER.recordSecurityAudit({
          category: 'github_api_error',
          action: method,
          endpoint: String(endpoint).slice(0, 140),
          repo: auditRepo,
          status: `${resp.status}:${errorKind}`,
          detail: msg
        });
      }

      const err = new Error(msg);
      err.status = resp.status;
      err.errorKind = errorKind;
      err.outcomeStatus = isTransient5xx && isMutating ? 'unknown' : 'rejected';
      err.data = data;
      lastErr = err;
      throw err;
    }
    throw lastErr || new Error('Falha inesperada na chamada GitHub API.');
  }

  const github = {
    normalizeGithubToken,
    parseGitRepoSpec,
    parseRepoFullName,

    classifyGithubTokenType(rawToken) {
      const clean = normalizeGithubToken(rawToken);
      if (!clean) return { kind: 'none', label: 'Sem Token (Acesso Público)' };
      if (/^github_pat_/i.test(clean)) return { kind: 'fine_grained_pat', label: 'Fine-Grained PAT (Escopo Granular)' };
      if (/^ghp_/i.test(clean)) return { kind: 'classic_pat', label: 'Classic PAT (Escopos OAuth)' };
      if (/^gho_/i.test(clean)) return { kind: 'oauth_token', label: 'Token OAuth App' };
      if (/^gh[us]_/i.test(clean)) return { kind: 'github_app', label: 'Token GitHub App (Curta Duração)' };
      return { kind: 'custom_pat', label: 'Token Personalizado / Enterprise' };
    },

    parseTokenExpirationHeader(rawHeader, nowMs = Date.now()) {
      const raw = String(rawHeader || '').trim();
      if (!raw) {
        return {
          hasExpiration: false,
          raw: '',
          expiresAtMs: 0,
          expiresAtIso: '',
          remainingMs: null,
          remainingDays: null,
          isExpired: false,
          expiringSoon: false,
          isExpiringSoon: false,
          status: 'no_expiration',
          label: '♾️ Sem expiração definida (válido até revogar)',
          durationLabel: '♾️ Sem expiração definida (válido até revogar)'
        };
      }
      const normalizedIso = raw
        .replace(/\s+UTC$/i, 'Z')
        .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})$/, '$1T$2$3:$4')
        .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})Z$/i, '$1T$2Z');
      const parsedMs = Date.parse(normalizedIso) || Date.parse(raw);
      if (!Number.isFinite(parsedMs) || parsedMs <= 0) {
        return {
          hasExpiration: true,
          raw,
          expiresAtMs: 0,
          expiresAtIso: '',
          remainingMs: null,
          remainingDays: null,
          isExpired: false,
          expiringSoon: false,
          isExpiringSoon: false,
          status: 'unknown_format',
          label: `⏳ Expiração informada: ${raw}`,
          durationLabel: `⏳ Expiração informada: ${raw}`
        };
      }
      const diffMs = parsedMs - nowMs;
      const days = Math.floor(diffMs / 86400000);
      const hours = Math.max(0, Math.floor((diffMs % 86400000) / 3600000));
      const dateStr = new Date(parsedMs).toLocaleDateString('pt-BR');
      if (diffMs <= 0) {
        return {
          hasExpiration: true,
          raw,
          expiresAtMs: parsedMs,
          expiresAtIso: new Date(parsedMs).toISOString(),
          remainingMs: 0,
          remainingDays: 0,
          isExpired: true,
          expiringSoon: true,
          isExpiringSoon: true,
          status: 'expired',
          label: `❌ Credencial expirada em ${dateStr}`,
          durationLabel: `❌ Credencial expirada em ${dateStr}`
        };
      }
      const expiringSoon = diffMs <= 72 * 3600000;
      const durationLabel =
        days >= 1
          ? `${expiringSoon ? '⚠️' : '⏳'} Expira em ${days}d ${hours}h (${dateStr})`
          : `⚠️ Expira em ${Math.max(1, hours)}h (${dateStr})`;
      return {
        hasExpiration: true,
        raw,
        expiresAtMs: parsedMs,
        expiresAtIso: new Date(parsedMs).toISOString(),
        remainingMs: diffMs,
        remainingDays: days,
        isExpired: false,
        expiringSoon,
        isExpiringSoon: expiringSoon,
        status: expiringSoon ? 'expiring_soon' : 'valid',
        label: durationLabel,
        durationLabel
      };
    },

    async verifyToken(token) {
      const clean = normalizeGithubToken(token);
      const { data, headers } = await ghRequest(clean, '/user');
      const scopes = (headers && headers.get && headers.get('x-oauth-scopes')) || '';
      const expHeader = (headers && headers.get && headers.get('github-authentication-token-expiration')) || '';
      const rlRemaining = Number((headers && headers.get && headers.get('x-ratelimit-remaining')) || 0);
      const rlLimit = Number((headers && headers.get && headers.get('x-ratelimit-limit')) || 0);
      const rlReset = Number((headers && headers.get && headers.get('x-ratelimit-reset')) || 0) * 1000;
      const tokenType = github.classifyGithubTokenType(clean);
      const expiration = github.parseTokenExpirationHeader(expHeader);
      return {
        ok: true,
        login: data.login,
        name: data.name || data.login,
        avatarUrl: data.avatar_url || '',
        htmlUrl: data.html_url || '',
        scopes,
        scopesList: scopes
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
        tokenType: tokenType.kind,
        tokenTypeLabel: tokenType.label,
        expiration,
        rateLimit: rlLimit > 0 ? { remaining: rlRemaining, limit: rlLimit, resetAtMs: rlReset } : null
      };
    },

    async inspectCredentialHealth(token, repoInput = '', fallbackOwner = '') {
      const parsedRepo = repoInput ? parseGitRepoSpec(repoInput, fallbackOwner) : null;
      const effectiveToken = normalizeGithubToken(token || (parsedRepo && parsedRepo.embeddedToken) || '');
      const tokenType = github.classifyGithubTokenType(effectiveToken);

      if (!effectiveToken) {
        let publicAccess = null;
        if (parsedRepo && parsedRepo.isGithub) {
          publicAccess = await github.checkRepoAccess('', repoInput, fallbackOwner).catch(() => null);
        }
        return {
          ok: true,
          valid: false,
          authenticated: false,
          login: '',
          tokenKind: tokenType.kind,
          tokenType: tokenType.kind,
          tokenTypeLabel: tokenType.label,
          scopes: [],
          scopesHeader: '',
          scopesList: [],
          expiration: {
            hasExpiration: false,
            isExpired: false,
            expiringSoon: false,
            isExpiringSoon: false,
            status: 'anonymous',
            label: '🔓 Sem credencial (Somente Leitura em repositórios públicos)',
            durationLabel: '🔓 Sem credencial (Somente Leitura em repositórios públicos)'
          },
          capabilities: {
            readRepo: Boolean(!parsedRepo || (publicAccess && !publicAccess.private)),
            pushCode: false,
            pullRequests: false,
            actionsWorkflow: false,
            projects: false,
            issues: false
          },
          permissionChips: [
            { id: 'code_read', label: 'Código Público (Read)', granted: Boolean(!parsedRepo || (publicAccess && !publicAccess.private)) },
            { id: 'code_write', label: 'Push / Branches', granted: false },
            { id: 'prs', label: 'Pull Requests (Criar)', granted: false },
            { id: 'issues', label: 'Issues (Escrita)', granted: false },
            { id: 'workflows', label: 'Actions / Workflows', granted: false }
          ],
          missingWarnings: ['Adicione um Token PAT no Cofre para habilitar Push de branches, abertura autônoma de PRs e repositórios privados.'],
          repoSummary: publicAccess
        };
      }

      const userVerification = await github.verifyToken(effectiveToken);
      const scopesList = userVerification.scopesList || [];
      const isClassic = userVerification.tokenType === 'classic_pat' || scopesList.length > 0;

      let repoAccess = null;
      if (parsedRepo && parsedRepo.isGithub) {
        repoAccess = await github
          .checkRepoAccess(effectiveToken, repoInput, userVerification.login || fallbackOwner)
          .catch(() => null);
      }

      const hasClassicRepoFull = scopesList.includes('repo');
      const hasClassicPublicRepo = scopesList.includes('public_repo');
      const hasClassicWorkflow = scopesList.includes('workflow');
      const hasClassicProject = scopesList.includes('project') || scopesList.includes('read:project');
      const hasClassicIssues = hasClassicRepoFull || hasClassicPublicRepo || scopesList.includes('public_repo');

      const canWriteCode = repoAccess
        ? Boolean(repoAccess.canPush)
        : isClassic
          ? Boolean(hasClassicRepoFull || hasClassicPublicRepo)
          : true;
      const canManagePrs = repoAccess
        ? Boolean(repoAccess.canCreatePR || repoAccess.canPush)
        : isClassic
          ? Boolean(hasClassicRepoFull || hasClassicPublicRepo)
          : true;
      const canManageIssues = isClassic ? Boolean(hasClassicIssues) : true;
      const canManageWorkflows = repoAccess
        ? Boolean(repoAccess.hasWorkflowScope)
        : isClassic
          ? Boolean(hasClassicWorkflow)
          : true;
      const canReadProjects = isClassic ? Boolean(hasClassicProject || hasClassicRepoFull) : true;

      const permissionChips = [
        {
          id: 'code_write',
          label: canWriteCode ? 'Código: Read & Push' : 'Código: Só Leitura',
          granted: canWriteCode
        },
        {
          id: 'prs',
          label: 'Pull Requests',
          granted: canManagePrs
        },
        {
          id: 'issues',
          label: 'Issues',
          granted: canManageIssues
        },
        {
          id: 'workflows',
          label: 'Actions / Workflows',
          granted: canManageWorkflows
        },
        {
          id: 'projects',
          label: 'Projects / Metadata',
          granted: canReadProjects
        }
      ];

      const missingWarnings = [];
      if (userVerification.expiration && userVerification.expiration.isExpired) {
        missingWarnings.push('Esta credencial GitHub está EXPIRADA. Gere um novo Token PAT.');
      } else if (userVerification.expiration && userVerification.expiration.expiringSoon) {
        missingWarnings.push('Atenção: esta credencial expira em menos de 72 horas.');
      }
      if (!canWriteCode) {
        missingWarnings.push(
          repoAccess && repoAccess.private
            ? 'Sem permissão de Push neste repositório privado (ative escopo "repo" ou "Contents: Read and write").'
            : 'Sem escopo de escrita em código ("repo" no Classic PAT ou "Contents: Read & write" no Fine-Grained PAT).'
        );
      }
      if (isClassic && !hasClassicWorkflow) {
        missingWarnings.push('Escopo "workflow" ausente: atualizações em .github/workflows serão recusadas pelo GitHub.');
      }

      return {
        ok: true,
        valid: !Boolean(userVerification.expiration && userVerification.expiration.isExpired),
        authenticated: true,
        login: userVerification.login,
        name: userVerification.name,
        tokenKind: userVerification.tokenType,
        tokenType: userVerification.tokenType,
        tokenTypeLabel: userVerification.tokenTypeLabel,
        scopes: scopesList,
        scopesHeader: userVerification.scopes,
        scopesList,
        expiration: userVerification.expiration,
        rateLimit: userVerification.rateLimit,
        canWriteCode,
        canManagePrs,
        canManageWorkflows,
        capabilities: {
          readRepo: true,
          pushCode: canWriteCode,
          pullRequests: canManagePrs,
          actionsWorkflow: canManageWorkflows,
          projects: canReadProjects,
          issues: canManageIssues
        },
        permissionChips,
        missingWarnings,
        repoSummary: repoAccess
      };
    },

    async listRepos(token, perPage = 100) {
      const { data } = await ghRequest(
        token,
        `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=${Math.min(100, Number(perPage || 100))}`
      );
      return (Array.isArray(data) ? data : []).map((r) => ({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner && r.owner.login,
        private: Boolean(r.private),
        defaultBranch: r.default_branch || 'main',
        htmlUrl: r.html_url,
        cloneUrl: r.clone_url || `https://github.com/${r.full_name}.git`,
        updatedAt: r.updated_at
      }));
    },

    async createRepo(token, opts = {}) {
      const rawName = String(opts.name || '').trim();
      const spec = parseGitRepoSpec(rawName);
      const name = spec ? spec.repo : rawName.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
      if (!name) throw new Error('Informe o nome do novo repositório.');
      const { data } = await ghRequest(token, '/user/repos', {
        method: 'POST',
        body: {
          name,
          description: opts.description || 'Criado via Arena Ultra Multi-Agent Suite',
          private: opts.private !== undefined ? Boolean(opts.private) : true,
          auto_init: true
        }
      });
      return {
        fullName: data.full_name,
        defaultBranch: data.default_branch || 'main',
        htmlUrl: data.html_url,
        cloneUrl: data.clone_url || `https://github.com/${data.full_name}.git`,
        private: Boolean(data.private)
      };
    },

    async checkRepoAccess(token, repoInput, fallbackOwner) {
      const parsed = parseGitRepoSpec(repoInput, fallbackOwner);
      if (!parsed) {
        throw new Error(
          'Link ou repositório inválido. Cole o link completo (ex.: https://github.com/usuario/repositorio) ou usuario/repositorio.'
        );
      }
      const effectiveToken = normalizeGithubToken(token || parsed.embeddedToken || '');
      if (!parsed.isGithub) {
        // DATA-04: Honest Forge detection — never send GitLab/Bitbucket/Gitea repos to api.github.com
        return {
          ok: true,
          isGithub: false,
          host: parsed.host,
          forgeUnsupportedForApiPush: true,
          fullName: parsed.fullName,
          htmlUrl: parsed.webUrl,
          cloneUrl: parsed.cloneUrl,
          defaultBranch: parsed.branchFromUrl || 'main',
          branchFromUrl: parsed.branchFromUrl || '',
          private: false,
          canPush: false,
          canCreatePR: false,
          authWarning: `Host "${parsed.host}" detectado: o Cofre Push/PR via API REST suporta exclusivamente GitHub (github.com). Clone Git padrão no terminal permanece disponível.`,
          authenticated: false
        };
      }

      const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
      let repoInfo = null;
      let respHeaders = null;
      let usedAuth = Boolean(effectiveToken);
      let authWarning = '';
      try {
        const res = await ghRequest(effectiveToken, base, { allowAnonymous: true });
        repoInfo = res.data;
        respHeaders = res.headers;
      } catch (err) {
        if (effectiveToken && (err.status === 401 || err.status === 403)) {
          try {
            const anonRes = await ghRequest('', base, { allowAnonymous: true });
            repoInfo = anonRes.data;
            usedAuth = false;
            authWarning =
              'O Token PAT informado falhou (expirado/inválido ou sem acesso a este repo), então o acesso caiu em somente-leitura.';
          } catch (_) {
            throw err;
          }
        } else {
          throw err;
        }
      }

      const scopesHeader = (respHeaders && respHeaders.get && respHeaders.get('x-oauth-scopes')) || '';
      const scopesList = scopesHeader
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const isClassicToken = Boolean(usedAuth && (scopesHeader || /^ghp_/i.test(effectiveToken)));
      const perms = repoInfo.permissions || {};
      const canPush = usedAuth ? Boolean(perms.push || perms.admin || perms.maintain) : false;
      const hasWorkflowScope = !usedAuth
        ? false
        : isClassicToken
          ? scopesList.includes('workflow')
          : true;

      const [prsProbe, actionsProbe] = await Promise.all([
        ghRequest(usedAuth ? effectiveToken : '', `${base}/pulls?state=open&per_page=100`, {
          allowAnonymous: true
        }).catch(() => ({ data: [] })),
        ghRequest(usedAuth ? effectiveToken : '', `${base}/actions/runs?per_page=3`, {
          allowAnonymous: true
        }).catch(() => ({ data: { total_count: 0 } }))
      ]);

      const openPrsCount = Array.isArray(prsProbe.data) ? prsProbe.data.length : 0;
      const trueIssuesCount = Math.max(0, Number(repoInfo.open_issues_count || 0) - openPrsCount);

      return {
        ok: true,
        isGithub: true,
        fullName: repoInfo.full_name || parsed.fullName,
        htmlUrl: repoInfo.html_url || parsed.webUrl,
        cloneUrl: repoInfo.clone_url || parsed.cloneUrl,
        defaultBranch: repoInfo.default_branch || 'main',
        branchFromUrl: parsed.branchFromUrl || '',
        private: Boolean(repoInfo.private),
        canPush,
        canCreatePR: canPush,
        hasWorkflowScope,
        scopes: scopesHeader,
        authWarning,
        openIssuesCount: trueIssuesCount,
        openPrsCount,
        actionsRunsCount: Number((actionsProbe.data && actionsProbe.data.total_count) || 0),
        quickTokenCreateUrl: QUICK_GITHUB_TOKEN_URL,
        authenticated: usedAuth
      };
    },

    async downloadRepoZipBytes(token, repoInput, ref) {
      const parsed = parseGitRepoSpec(repoInput);
      if (!parsed || !parsed.isGithub) {
        throw new Error('Link do GitHub inválido para baixar pacote ZIP.');
      }
      const pat = normalizeGithubToken(token || parsed.embeddedToken || '');
      const cleanRef = String(ref || parsed.branchFromUrl || '').trim();
      const endpoint = cleanRef
        ? `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/zipball/${encodeRefSegments(cleanRef)}`
        : `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/zipball`;
      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      };
      if (pat) headers.Authorization = `Bearer ${pat}`;
      const resp = await fetch(endpoint, { method: 'GET', headers, redirect: 'follow' });
      if (!resp.ok) {
        throw new Error(`Falha ao baixar ZIP do repositório (${resp.status}).`);
      }
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    },

    async getRepoOverview(token, repoFullName, fallbackOwner) {
      const parsed = parseGitRepoSpec(repoFullName, fallbackOwner);
      if (!parsed || !parsed.isGithub) {
        throw new Error(
          'Informe um link do GitHub (https://github.com/usuario/repositorio) ou usuario/repositorio.'
        );
      }
      const effectiveToken = normalizeGithubToken(token || parsed.embeddedToken || '');
      const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
      let authForCalls = effectiveToken;
      let repoInfo;
      try {
        const r = await ghRequest(authForCalls, base, { allowAnonymous: true });
        repoInfo = r.data;
      } catch (err) {
        if (authForCalls && (err.status === 401 || err.status === 403)) {
          const anon = await ghRequest('', base, { allowAnonymous: true });
          repoInfo = anon.data;
          authForCalls = '';
        } else {
          throw err;
        }
      }
      const [{ data: branches }, { data: pulls }, { data: issuesRaw }, { data: actionsRaw }, { data: commits }] =
        await Promise.all([
          ghRequest(authForCalls, `${base}/branches?per_page=30`, { allowAnonymous: true }).catch(() => ({ data: [] })),
          ghRequest(authForCalls, `${base}/pulls?state=all&per_page=15`, { allowAnonymous: true }).catch(() => ({
            data: []
          })),
          ghRequest(authForCalls, `${base}/issues?state=open&per_page=15`, { allowAnonymous: true }).catch(() => ({
            data: []
          })),
          ghRequest(authForCalls, `${base}/actions/runs?per_page=6`, { allowAnonymous: true }).catch(() => ({
            data: { workflow_runs: [] }
          })),
          ghRequest(authForCalls, `${base}/commits?per_page=12`, { allowAnonymous: true }).catch(() => ({ data: [] }))
        ]);

      const pureIssues = (Array.isArray(issuesRaw) ? issuesRaw : []).filter((i) => i && !i.pull_request);
      const runsList = (actionsRaw && Array.isArray(actionsRaw.workflow_runs) ? actionsRaw.workflow_runs : []).slice(0, 6);

      return {
        fullName: repoInfo.full_name,
        defaultBranch: repoInfo.default_branch || 'main',
        private: Boolean(repoInfo.private),
        htmlUrl: repoInfo.html_url,
        branches: (Array.isArray(branches) ? branches : []).map((b) => ({
          name: b.name,
          sha: b.commit && String(b.commit.sha || '').slice(0, 7)
        })),
        issues: pureIssues.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          htmlUrl: i.html_url
        })),
        actionsRuns: runsList.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          branch: r.head_branch,
          htmlUrl: r.html_url
        })),
        pulls: (Array.isArray(pulls) ? pulls : []).map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          merged: Boolean(p.merged_at),
          head: p.head && p.head.ref,
          base: p.base && p.base.ref,
          htmlUrl: p.html_url,
          createdAt: p.created_at
        })),
        commits: (Array.isArray(commits) ? commits : []).map((c) => ({
          sha: String(c.sha || '').slice(0, 7),
          message: (c.commit && c.commit.message) || '',
          author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || 'Agent',
          date: c.commit && c.commit.author && c.commit.author.date,
          htmlUrl: c.html_url
        }))
      };
    },

    async pushFilesCommit(token, opts = {}) {
      const parsed = parseGitRepoSpec(opts.repo, opts.fallbackOwner);
      if (!parsed) {
        throw new Error(
          'Informe o link do repositório GitHub (https://github.com/usuario/repositorio) ou usuario/repositorio.'
        );
      }
      if (!parsed.isGithub) {
        // DATA-04: Explicit non-GitHub Forge error
        throw new Error(
          `Host "${parsed.host}" detectado: o Cofre Push/PR via API REST integrada suporta exclusivamente GitHub (github.com).`
        );
      }
      const effectiveToken = normalizeGithubToken(token || parsed.embeddedToken || '');
      const files = Array.isArray(opts.files) ? opts.files.slice() : [];
      const explicitDeleted = Array.isArray(opts.deletedPaths)
        ? opts.deletedPaths
            .map((p) => String(p || '').replace(/\\/g, '/').replace(/^\/+/, ''))
            .filter(Boolean)
        : [];
      if (!files.length && !explicitDeleted.length) {
        throw new Error('Nenhum arquivo encontrado para enviar ao GitHub.');
      }

      const workspaceStatus = String(opts.workspaceStatus || opts.snapshotStatus || 'complete').toLowerCase();
      const omittedList = Array.isArray(opts.omittedFiles) ? opts.omittedFiles : [];
      if (
        workspaceStatus === 'partial' &&
        omittedList.length > 0 &&
        !files.some((f) => String(f && f.path).replace(/^\/+/, '') === '.au-manifest.json')
      ) {
        files.push({
          path: '.au-manifest.json',
          content: JSON.stringify(
            {
              schemaVersion: 4,
              status: 'partial',
              generatedAt: new Date().toISOString(),
              omittedCount: omittedList.length,
              omitted: omittedList.slice(0, 200)
            },
            null,
            2
          )
        });
      }
      const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
      const { data: repoInfo } = await ghRequest(effectiveToken, base);
      const defaultBranch = repoInfo.default_branch || 'main';
      const baseBranch = (opts.baseBranch || parsed.branchFromUrl || defaultBranch).trim();
      let effectiveBaseBranch = baseBranch;
      const targetBranch = (opts.branch || baseBranch).trim();
      const commitMessage = (opts.message || 'feat: atualização enviada via Arena Ultra Multi-Agent').trim();

      // 1. Resolve current tip of targetBranch (or baseBranch if creating a new branch; or initialize empty repo!)
      let parentCommitSha = '';
      let baseTreeSha = '';
      let targetRefExists = false;

      try {
        const { data: refData } = await ghRequest(effectiveToken, `${base}/git/ref/heads/${encodeRefSegments(targetBranch)}`);
        parentCommitSha = refData.object.sha;
        targetRefExists = true;
        if (baseBranch !== targetBranch) {
          try {
            await ghRequest(effectiveToken, `${base}/git/ref/heads/${encodeRefSegments(baseBranch)}`);
            effectiveBaseBranch = baseBranch;
          } catch (_) {
            effectiveBaseBranch = defaultBranch;
          }
        }
      } catch (e) {
        if (e.status === 404 || e.status === 409) {
          let resolvedBase = false;
          for (const candidateBase of [baseBranch, defaultBranch]) {
            if (!candidateBase || resolvedBase) continue;
            try {
              const { data: baseRef } = await ghRequest(
                effectiveToken,
                `${base}/git/ref/heads/${encodeRefSegments(candidateBase)}`
              );
              parentCommitSha = baseRef.object.sha;
              effectiveBaseBranch = candidateBase;
              resolvedBase = true;
            } catch (_) {}
          }
          if (!resolvedBase) {
            await ghRequest(effectiveToken, `${base}/contents/README.md`, {
              method: 'PUT',
              body: {
                message: 'chore: inicialização automática do repositório via Arena Ultra',
                content: uint8ToBase64(new TextEncoder().encode(`# ${parsed.repo}\n\nInicializado com Arena Ultra.\n`)),
                branch: baseBranch
              }
            });
            const { data: bootRef } = await ghRequest(
              effectiveToken,
              `${base}/git/ref/heads/${encodeRefSegments(baseBranch)}`
            );
            parentCommitSha = bootRef.object.sha;
            effectiveBaseBranch = baseBranch;
            if (targetBranch === baseBranch) targetRefExists = true;
          }
        } else {
          throw e;
        }
      }

      if (parentCommitSha) {
        const { data: commitObj } = await ghRequest(effectiveToken, `${base}/git/commits/${parentCommitSha}`);
        baseTreeSha = commitObj.tree && commitObj.tree.sha;
        // ARENA-17: Reconcile uncertain prior write by operationId / exact commit message before creating a duplicate commit
        if (
          opts.reconcileBeforeWrite &&
          targetRefExists &&
          commitObj.message &&
          ((opts.operationId && commitObj.message.includes(opts.operationId)) ||
            commitObj.message.trim() === commitMessage)
        ) {
          return {
            ok: true,
            reconciledExistingCommit: true,
            repo: parsed.fullName,
            branch: targetBranch,
            baseBranch: effectiveBaseBranch,
            createdBranch: false,
            commitSha: parentCommitSha,
            shortSha: String(parentCommitSha).slice(0, 7),
            filesCount: files.length,
            deletedCount: 0,
            commitUrl: `https://github.com/${parsed.fullName}/commit/${parentCommitSha}`,
            branchUrl: `https://github.com/${parsed.fullName}/tree/${encodeRefSegments(targetBranch)}`
          };
        }
      }

      // DATA-02: Preserve executable (`100755`) and symlink (`120000`) git file modes
      function resolveGitFileMode(f, rawBytes) {
        if (f.mode === '120000' || f.symlink === true) return '120000';
        if (f.mode === '100755' || f.executable === true) return '100755';
        const p = String(f.path || '');
        if ((/\.(sh|bash)$/i.test(p) || /^bin\//i.test(p)) && rawBytes && rawBytes.length >= 2) {
          if (rawBytes[0] === 0x23 && rawBytes[1] === 0x21) return '100755';
        }
        return '100644';
      }

      // 2. Upload Blobs (concurrency-limited in batches of 6 to stay well within GitHub secondary rate limits)
      const treeItems = [];
      const uploadedPathSet = new Set();
      const batchSize = 6;
      for (let i = 0; i < files.length; i += batchSize) {
        const slice = files.slice(i, i + batchSize);
        const created = await Promise.all(
          slice.map(async (f) => {
            const cleanPath = String(f.path || '')
              .replace(/\\/g, '/')
              .replace(/^\/+/, '');
            uploadedPathSet.add(cleanPath);
            const rawBytes =
              f.bytes instanceof Uint8Array
                ? f.bytes
                : f.base64
                  ? base64ToUint8(f.base64)
                  : new TextEncoder().encode(String(f.content !== undefined ? f.content : f.text || ''));
            const b64 = f.base64 || uint8ToBase64(rawBytes);
            const gitMode = resolveGitFileMode(f, rawBytes);
            const { data: blob } = await ghRequest(effectiveToken, `${base}/git/blobs`, {
              method: 'POST',
              body: { content: b64, encoding: 'base64' }
            });
            return {
              path: cleanPath,
              mode: gitMode,
              type: 'blob',
              sha: blob.sha
            };
          })
        );
        treeItems.push(...created);
      }

      // 2b. DATA-01 + ARENA-15: Support safe file deletions (`sha: null`) ONLY when snapshot is `complete` (or explicit deletedPaths)
      let deletionsSkippedPartialSnapshot = false;
      const deletionSet = new Set(explicitDeleted.filter((p) => !uploadedPathSet.has(p)));

      if (opts.syncDeletions && baseTreeSha) {
        if (workspaceStatus !== 'complete') {
          // ARENA-15 SAFETY INVARIANT: NEVER deduce deletions from a partial or failed snapshot!
          deletionsSkippedPartialSnapshot = true;
        } else {
          try {
            const { data: recTree } = await ghRequest(
              effectiveToken,
              `${base}/git/trees/${baseTreeSha}?recursive=1`
            );
            if (recTree && !recTree.truncated && Array.isArray(recTree.tree)) {
              for (let t = 0; t < recTree.tree.length; t++) {
                const node = recTree.tree[t];
                if (node && node.type === 'blob' && node.path && !uploadedPathSet.has(node.path)) {
                  // Do not auto-delete repository .github workflows unless explicitly requested
                  if (node.path.startsWith('.github/') && !opts.allowWorkflowDeletions) continue;
                  deletionSet.add(node.path);
                }
              }
            }
          } catch (_) {}
        }
      }

      const deletedPathsFinal = Array.from(deletionSet);
      const maxAutoDeletions = Number(opts.maxAutoDeletions !== undefined ? opts.maxAutoDeletions : 15);
      if (deletedPathsFinal.length > maxAutoDeletions && !opts.confirmMassDeletion) {
        const massErr = new Error(
          `Proteção contra deleção em massa: ${deletedPathsFinal.length} arquivos seriam removidos (limite automático: ${maxAutoDeletions}). Confirmação humana necessária.`
        );
        massErr.code = 'NEEDS_HUMAN_MASS_DELETION';
        massErr.deletedCandidates = deletedPathsFinal;
        throw massErr;
      }

      if (deletedPathsFinal.length > 0 && baseTreeSha) {
        // Verify paths exist in base tree when possible so GitHub Git Trees API never 422s on non-existent deletion
        let existingBlobPaths = null;
        try {
          const { data: checkTree } = await ghRequest(
            effectiveToken,
            `${base}/git/trees/${baseTreeSha}?recursive=1`
          );
          if (checkTree && Array.isArray(checkTree.tree)) {
            existingBlobPaths = new Set(
              checkTree.tree.filter((n) => n && n.type === 'blob').map((n) => n.path)
            );
          }
        } catch (_) {}

        for (let d = 0; d < deletedPathsFinal.length; d++) {
          const delPath = deletedPathsFinal[d];
          if (existingBlobPaths && !existingBlobPaths.has(delPath)) continue;
          treeItems.push({
            path: delPath,
            mode: '100644',
            type: 'blob',
            sha: null
          });
        }
      }

      // 3. Create Git Tree
      const treeBody = { tree: treeItems };
      if (baseTreeSha && !opts.replaceEntireTree) {
        treeBody.base_tree = baseTreeSha;
      }
      const { data: newTree } = await ghRequest(effectiveToken, `${base}/git/trees`, {
        method: 'POST',
        body: treeBody
      });

      // 4. Create Git Commit
      const { data: newCommit } = await ghRequest(effectiveToken, `${base}/git/commits`, {
        method: 'POST',
        body: {
          message: commitMessage,
          tree: newTree.sha,
          parents: parentCommitSha ? [parentCommitSha] : []
        }
      });

      // 5. Update or Create Branch Ref
      if (targetRefExists) {
        await ghRequest(effectiveToken, `${base}/git/refs/heads/${encodeRefSegments(targetBranch)}`, {
          method: 'PATCH',
          body: { sha: newCommit.sha, force: Boolean(opts.force) }
        });
      } else {
        await ghRequest(effectiveToken, `${base}/git/refs`, {
          method: 'POST',
          body: {
            ref: `refs/heads/${targetBranch}`,
            sha: newCommit.sha
          }
        });
      }

      return {
        ok: true,
        repo: parsed.fullName,
        branch: targetBranch,
        baseBranch: effectiveBaseBranch,
        createdBranch: !targetRefExists,
        commitSha: newCommit.sha,
        shortSha: String(newCommit.sha).slice(0, 7),
        filesCount: files.length,
        deletedCount: deletedPathsFinal.length,
        deletionsSkippedPartialSnapshot,
        workspaceStatus,
        commitUrl: `https://github.com/${parsed.fullName}/commit/${newCommit.sha}`,
        branchUrl: `https://github.com/${parsed.fullName}/tree/${encodeRefSegments(targetBranch)}`
      };
    },

    async createPullRequest(token, opts = {}) {
      const parsed = parseGitRepoSpec(opts.repo, opts.fallbackOwner);
      if (!parsed || !parsed.isGithub) {
        throw new Error(
          'Informe o link do repositório GitHub (https://github.com/usuario/repositorio) ou usuario/repositorio.'
        );
      }
      const effectiveToken = normalizeGithubToken(token || parsed.embeddedToken || '');
      const head = String(opts.head || '').trim();
      let base = String(opts.base || parsed.branchFromUrl || 'main').trim();
      if (!head || head === base) {
        throw new Error('A branch de origem (head) deve ser diferente da branch base para abrir um Pull Request.');
      }
      const baseApi = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;

      const checkExistingAndCreate = async (targetBase) => {
        const { data: existing } = await ghRequest(
          effectiveToken,
          `${baseApi}/pulls?state=open&head=${encodeURIComponent(parsed.owner + ':' + head)}&base=${encodeURIComponent(targetBase)}`
        );
        if (Array.isArray(existing) && existing.length > 0) {
          return {
            ok: true,
            alreadyExisted: true,
            number: existing[0].number,
            htmlUrl: existing[0].html_url,
            title: existing[0].title,
            base: targetBase
          };
        }
        const { data: pr } = await ghRequest(effectiveToken, `${baseApi}/pulls`, {
          method: 'POST',
          body: {
            title: opts.title || `🤝 Entrega Multi-Agent (${head})`,
            head,
            base: targetBase,
            body: opts.body || 'Pull Request criado automaticamente pela suíte **Arena Ultra Multi-Agent**.'
          }
        });
        return {
          ok: true,
          alreadyExisted: false,
          number: pr.number,
          htmlUrl: pr.html_url,
          title: pr.title,
          base: targetBase
        };
      };

      try {
        return await checkExistingAndCreate(base);
      } catch (err) {
        if (err && err.status === 422) {
          const { data: repoInfo } = await ghRequest(effectiveToken, baseApi);
          const realDefault = String((repoInfo && repoInfo.default_branch) || '').trim();
          if (realDefault && realDefault !== base && realDefault !== head) {
            base = realDefault;
            return await checkExistingAndCreate(base);
          }
        }
        throw err;
      }
    },

    async ensureAutoPullRequestForBranch(token, opts = {}) {
      const parsed = parseGitRepoSpec(opts.repo, opts.fallbackOwner);
      const effectiveToken = normalizeGithubToken(token || (parsed && parsed.embeddedToken) || '');
      if (!parsed || !parsed.isGithub || !effectiveToken) {
        return { ok: false, skipped: true };
      }
      const baseApi = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
      const { data: repoInfo } = await ghRequest(effectiveToken, baseApi);
      const realDefault = String(repoInfo.default_branch || 'main').trim();
      let base = String(opts.base || realDefault).trim();
      const head = String(opts.head || '').trim();
      if (!head || head === base) {
        if (head && realDefault && head !== realDefault && base !== realDefault) {
          base = realDefault;
        } else {
          return { ok: false, skipped: true };
        }
      }

      // Check whether the Agent pushed commits to `head` ahead of `base` (falling back to repo default_branch if `base` e.g. 'main' doesn't exist on a 'master' repo)
      let comparedOk = false;
      for (const candidateBase of [base, realDefault]) {
        if (!candidateBase || candidateBase === head || comparedOk) continue;
        try {
          const cmpEndpoint = `${baseApi}/compare/${encodeRefSegments(candidateBase)}...${encodeRefSegments(head)}`;
          const { data: cmp } = await ghRequest(effectiveToken, cmpEndpoint);
          if (!cmp || Number(cmp.ahead_by || 0) <= 0) {
            return { ok: false, skipped: true, aheadBy: 0 };
          }
          base = candidateBase;
          comparedOk = true;
        } catch (_) {}
      }
      if (!comparedOk) {
        return { ok: false, skipped: true };
      }

      return await github.createPullRequest(effectiveToken, {
        repo: parsed.fullName,
        head,
        base,
        title: opts.title || `🚀 PR Automático (${head}) — Arena Ultra`,
        body:
          opts.body ||
          `Pull Request aberto automaticamente sem intervenção humana pela suíte **Arena Ultra** a partir da branch \`${head}\`.`
      });
    },

    async pollRepoRefsSnapshot(token, repoInput, fallbackOwner) {
      const parsed = parseGitRepoSpec(repoInput, fallbackOwner);
      if (!parsed || !parsed.isGithub) {
        throw new Error('Repositório GitHub inválido para monitoramento de branches/PRs.');
      }
      const effectiveToken = normalizeGithubToken(token || parsed.embeddedToken || '');
      const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
      let authTok = effectiveToken;
      let repoData = null;
      try {
        const r = await ghRequest(authTok, base, { allowAnonymous: true });
        repoData = r.data;
      } catch (err) {
        if (authTok && (err.status === 401 || err.status === 403)) {
          const anon = await ghRequest('', base, { allowAnonymous: true });
          repoData = anon.data;
          authTok = '';
        } else {
          throw err;
        }
      }
      const [brRes, prRes] = await Promise.all([
        ghRequest(authTok, `${base}/branches?per_page=40`, { allowAnonymous: true }).catch(() => ({ data: [] })),
        ghRequest(authTok, `${base}/pulls?state=all&sort=updated&direction=desc&per_page=25`, {
          allowAnonymous: true
        }).catch(() => ({ data: [] }))
      ]);
      return {
        fullName: (repoData && repoData.full_name) || parsed.fullName,
        defaultBranch: (repoData && repoData.default_branch) || 'main',
        branches: (Array.isArray(brRes.data) ? brRes.data : []).map((b) => ({
          name: String(b.name || ''),
          sha: String((b.commit && b.commit.sha) || ''),
          shortSha: String((b.commit && b.commit.sha) || '').slice(0, 7)
        })),
        pulls: (Array.isArray(prRes.data) ? prRes.data : []).map((p) => ({
          number: Number(p.number || 0),
          title: String(p.title || ''),
          state: String(p.state || 'open'),
          merged: Boolean(p.merged_at),
          head: String((p.head && p.head.ref) || ''),
          headSha: String((p.head && p.head.sha) || '').slice(0, 7),
          base: String((p.base && p.base.ref) || ''),
          author: String((p.user && p.user.login) || ''),
          htmlUrl: String(p.html_url || ''),
          updatedAt: String(p.updated_at || '')
        }))
      };
    },

    async executeVaultBrokerAction(token, opts = {}) {
      const parsed = parseGitRepoSpec(opts.repo, opts.fallbackOwner);
      if (!parsed || !parsed.isGithub) {
        throw new Error('Repositório inválido na requisição ao Cofre Git.');
      }
      const accessLevel = String(opts.accessLevel || 'push_and_pr');
      if (accessLevel === 'revoked') {
        throw new Error('Acesso ao Cofre GitHub revogado pelo Coordenador para este Agente.');
      }
      const action = String(opts.action || 'overview').toLowerCase();
      const writeActions = new Set(['issue_new', 'pr_comment', 'pr_create', 'pr_merge', 'push_files', 'pr_ship']);
      const prActions = new Set(['pr_create', 'pr_merge', 'pr_ship']);

      if (writeActions.has(action) && accessLevel === 'read_only') {
        throw new Error(`Permissão insuficiente no Cofre: seu papel está em "Somente Leitura" (ação bloqueada: ${action}).`);
      }
      if (prActions.has(action) && accessLevel !== 'push_and_pr') {
        throw new Error(`Permissão insuficiente no Cofre: abertura/merge de PR exige nível "Push + PR" (atual: ${accessLevel}).`);
      }

      const effectiveToken = normalizeGithubToken(token || parsed.embeddedToken || '');
      const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
      const args = opts.args && typeof opts.args === 'object' ? opts.args : {};

      if (action === 'overview' || action === 'status') {
        return await github.getRepoOverview(effectiveToken, parsed.fullName, opts.fallbackOwner);
      }
      if (action === 'prs') {
        const st = encodeURIComponent(String(args.state || 'open'));
        const { data } = await ghRequest(effectiveToken, `${base}/pulls?state=${st}&per_page=25`, { allowAnonymous: true });
        return Array.isArray(data) ? data : [];
      }
      if (action === 'pr') {
        const num = Number(args.number || 0);
        const [prR, filesR, commentsR] = await Promise.all([
          ghRequest(effectiveToken, `${base}/pulls/${num}`, { allowAnonymous: true }),
          ghRequest(effectiveToken, `${base}/pulls/${num}/files?per_page=50`, { allowAnonymous: true }).catch(() => ({ data: [] })),
          ghRequest(effectiveToken, `${base}/issues/${num}/comments?per_page=30`, { allowAnonymous: true }).catch(() => ({ data: [] }))
        ]);
        return { pr: prR.data, files: filesR.data, comments: commentsR.data };
      }
      if (action === 'issues') {
        const st = encodeURIComponent(String(args.state || 'open'));
        const { data } = await ghRequest(effectiveToken, `${base}/issues?state=${st}&per_page=25`, { allowAnonymous: true });
        return (Array.isArray(data) ? data : []).filter((i) => i && !i.pull_request);
      }
      if (action === 'issue') {
        const num = Number(args.number || 0);
        const [issR, comR] = await Promise.all([
          ghRequest(effectiveToken, `${base}/issues/${num}`, { allowAnonymous: true }),
          ghRequest(effectiveToken, `${base}/issues/${num}/comments?per_page=30`, { allowAnonymous: true }).catch(() => ({ data: [] }))
        ]);
        return { issue: issR.data, comments: comR.data };
      }
      if (action === 'actions') {
        const { data } = await ghRequest(effectiveToken, `${base}/actions/runs?per_page=12`, { allowAnonymous: true });
        return (data && data.workflow_runs) || [];
      }
      if (action === 'action_run') {
        const runId = encodeURIComponent(String(args.runId || ''));
        const [runR, jobsR] = await Promise.all([
          ghRequest(effectiveToken, `${base}/actions/runs/${runId}`, { allowAnonymous: true }),
          ghRequest(effectiveToken, `${base}/actions/runs/${runId}/jobs?per_page=30`, { allowAnonymous: true }).catch(() => ({ data: { jobs: [] } }))
        ]);
        return { run: runR.data, jobs: (jobsR.data && jobsR.data.jobs) || [] };
      }
      if (action === 'branches') {
        const { data } = await ghRequest(effectiveToken, `${base}/branches?per_page=40`, { allowAnonymous: true });
        return Array.isArray(data) ? data : [];
      }
      if (action === 'projects') {
        return await github.listProjectsV2(effectiveToken, parsed.fullName, opts.fallbackOwner);
      }
      if (action === 'insights') {
        const [contribR, langsR, commitsR] = await Promise.all([
          ghRequest(effectiveToken, `${base}/contributors?per_page=15`, { allowAnonymous: true }).catch(() => ({ data: [] })),
          ghRequest(effectiveToken, `${base}/languages`, { allowAnonymous: true }).catch(() => ({ data: {} })),
          ghRequest(effectiveToken, `${base}/commits?per_page=10`, { allowAnonymous: true }).catch(() => ({ data: [] }))
        ]);
        return { contributors: contribR.data, languages: langsR.data, recentCommits: commitsR.data };
      }
      if (action === 'issue_new') {
        const { data } = await ghRequest(effectiveToken, `${base}/issues`, {
          method: 'POST',
          body: { title: String(args.title || 'Issue'), body: String(args.body || '') }
        });
        return { number: data.number, htmlUrl: data.html_url, title: data.title };
      }
      if (action === 'pr_comment') {
        const num = Number(args.number || 0);
        const { data } = await ghRequest(effectiveToken, `${base}/issues/${num}/comments`, {
          method: 'POST',
          body: { body: String(args.body || '') }
        });
        return { id: data.id, htmlUrl: data.html_url };
      }
      if (action === 'pr_merge') {
        const num = Number(args.number || 0);
        const { data } = await ghRequest(effectiveToken, `${base}/pulls/${num}/merge`, {
          method: 'PUT',
          body: { merge_method: String(args.method || 'squash') }
        });
        return data;
      }
      if (action === 'push_files' || action === 'pr_ship') {
        const targetBranch = String(args.branch || opts.assignedBranch || '').trim();
        const baseBr = String(args.baseBranch || opts.baseBranch || 'main').trim();
        if (accessLevel === 'push_branch' && opts.assignedBranch && targetBranch !== opts.assignedBranch) {
          throw new Error(
            `Restrição de branch do Cofre: este Agente só tem autorização para push na branch "${opts.assignedBranch}" (tentativa: "${targetBranch}").`
          );
        }
        if (!opts.isSynthesizer && (targetBranch === 'main' || targetBranch === 'master' || targetBranch === baseBr)) {
          if (opts.branchMode !== 'single_shared_branch') {
            throw new Error(`Proteção do Cofre: push direto na branch base "${targetBranch}" bloqueado; use sua branch dedicada.`);
          }
        }
        const pushOut = await github.pushFilesCommit(effectiveToken, {
          repo: parsed.fullName,
          branch: targetBranch,
          baseBranch: baseBr,
          message: String(args.message || 'feat: entrega via Cofre Seguro Arena Ultra'),
          files: Array.isArray(args.files) ? args.files : [],
          deletedPaths: Array.isArray(args.deletedPaths) ? args.deletedPaths : [],
          syncDeletions: Boolean(args.syncDeletions),
          workspaceStatus: String(args.workspaceStatus || opts.workspaceStatus || 'complete'),
          operationId: String(args.operationId || ''),
          reconcileBeforeWrite: Boolean(args.reconcileBeforeWrite)
        });
        let prOut = null;
        if (action === 'pr_ship' && targetBranch !== (pushOut.baseBranch || baseBr)) {
          prOut = await github.createPullRequest(effectiveToken, {
            repo: parsed.fullName,
            head: targetBranch,
            base: pushOut.baseBranch || baseBr,
            title: String(args.prTitle || args.message || `🚀 Entrega (${targetBranch})`),
            body: String(args.prBody || `Commit \`${pushOut.shortSha}\` publicado via Cofre Seguro Zero-Token do Arena Ultra.`)
          });
        }
        return Object.assign({}, pushOut, { pullRequest: prOut });
      }
      throw new Error(`Ação desconhecida no Cofre Git: ${action}`);
    },

    // DATA-05: GitHub Projects v2 via GraphQL API (replaces deprecated REST /projects)
    async listProjectsV2(token, repoFullName, fallbackOwner) {
      const parsed = parseGitRepoSpec(repoFullName, fallbackOwner);
      if (!parsed || !parsed.isGithub) {
        throw new Error('Repositório GitHub inválido para consultar Projects v2.');
      }
      const effectiveToken = normalizeGithubToken(token || parsed.embeddedToken || '');
      if (!effectiveToken) {
        return {
          ok: false,
          projects: [],
          note: 'A API GraphQL de GitHub Projects v2 exige um Token PAT autenticado (com escopo read:project).'
        };
      }
      const query = `
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            projectsV2(first: 20) {
              nodes {
                number
                title
                url
                closed
                shortDescription
                updatedAt
              }
            }
          }
        }
      `;
      const { data } = await ghRequest(effectiveToken, '/graphql', {
        method: 'POST',
        body: {
          query,
          variables: { owner: parsed.owner, repo: parsed.repo }
        }
      });
      if (data && Array.isArray(data.errors) && data.errors.length > 0 && !(data.data && data.data.repository)) {
        return {
          ok: false,
          projects: [],
          note: data.errors.map((e) => e.message).join(' | ')
        };
      }
      const nodes =
        (data &&
          data.data &&
          data.data.repository &&
          data.data.repository.projectsV2 &&
          data.data.repository.projectsV2.nodes) ||
        [];
      return {
        ok: true,
        projects: nodes.filter(Boolean).map((p) => ({
          number: p.number,
          title: p.title,
          url: p.url,
          state: p.closed ? 'closed' : 'open',
          description: p.shortDescription || '',
          updatedAt: p.updatedAt || ''
        }))
      };
    }
  };

  const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[i] = c >>> 0;
    }
    return t;
  })();

  function computeCrc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildZipArchive(files = []) {
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    let count = 0;

    for (const f of files) {
      if (!f || !f.path) continue;
      const cleanPath = String(f.path).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!cleanPath || cleanPath.includes('..')) continue;
      const nameBytes = enc.encode(cleanPath);
      const dataBytes =
        f.bytes instanceof Uint8Array
          ? f.bytes
          : f.base64
            ? base64ToUint8(f.base64)
            : enc.encode(String(f.content !== undefined ? f.content : f.text || ''));
      const crc = computeCrc32(dataBytes);
      const size = dataBytes.length >>> 0;

      // Preserve Unix file mode in Central Directory external attributes (DATA-02)
      let unixAttrs = 0o100644;
      if (f.mode === '100755' || f.executable === true) unixAttrs = 0o100755;
      else if (f.mode === '120000' || f.symlink === true) unixAttrs = 0o120777;
      const externalFileAttrs = (unixAttrs << 16) >>> 0;

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
      lv.setUint16(8, 0, true); // STORE (0)
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 0x0314, true); // Unix creator (3) + v2.0 (20)
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, externalFileAttrs, true);
      cv.setUint32(42, localOffset >>> 0, true);
      ch.set(nameBytes, 46);

      localParts.push(lh, dataBytes);
      centralParts.push(ch);
      localOffset += lh.length + dataBytes.length;
      count += 1;
    }

    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, count, true);
    ev.setUint16(10, count, true);
    ev.setUint32(12, centralSize >>> 0, true);
    ev.setUint32(16, localOffset >>> 0, true);
    ev.setUint16(20, 0, true);

    const out = new Uint8Array(localOffset + centralSize + 22);
    let pos = 0;
    for (const p of localParts) {
      out.set(p, pos);
      pos += p.length;
    }
    for (const p of centralParts) {
      out.set(p, pos);
      pos += p.length;
    }
    out.set(eocd, pos);
    return out;
  }

  global.AU_INTEGRATIONS = {
    PROVIDER_ORDER,
    QUICK_GITHUB_TOKEN_URL,
    FINE_GRAINED_GITHUB_TOKEN_URL,
    REVOKE_GITHUB_TOKEN_URL,
    scrubSecrets,
    scrubReasoningBlocks,
    sanitizeFilename,
    generateFilebinId,
    uint8ToBase64,
    base64ToUint8,
    detectProviderFromUrl,
    uploadToProvider,
    uploadWithFallback,
    listFilebinFiles,
    fetchSharedFileBytes,
    isExcludedZipPath,
    extractZipArchive,
    buildZipArchive,
    normalizeGithubToken,
    parseGitRepoSpec,
    extractGithubRepoFromText,
    github
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
