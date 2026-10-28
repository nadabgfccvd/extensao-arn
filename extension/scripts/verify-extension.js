#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`❌ [VERIFY FAIL] ${msg}`);
  process.exit(1);
}

// 1. Validate manifest.json
const manifestPath = path.join(ROOT, 'manifest.json');
if (!fs.existsSync(manifestPath)) fail('manifest.json missing');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!/^4\.\d+\.\d+$/.test(String(manifest.version || ''))) fail(`Expected SemVer 4.x.y, got ${manifest.version}`);
if (Number(manifest.minimum_chrome_version) < 116) {
  fail('minimum_chrome_version must be >= 116 for storage.session & MV3 stability');
}
if ((manifest.permissions || []).includes('cookies')) {
  fail('SEC-09 violation: cookies permission must not be present');
}
const csp = manifest.content_security_policy && manifest.content_security_policy.extension_pages;
if (!csp || !csp.includes("script-src 'self'") || !csp.includes("object-src 'none'")) {
  fail('SEC-10 violation: hardened extension_pages CSP missing');
}
for (const war of manifest.web_accessible_resources || []) {
  if (!war.use_dynamic_url) {
    fail('SEC-10 violation: web_accessible_resources must enable use_dynamic_url: true');
  }
}

// 2. Verify required v4.0 documentation files
for (const doc of ['SPEC.md', 'PERMISSIONS.md', 'CHANGELOG.md', 'COMO_INSTALAR.md', 'HARNESS_GUIDE.md', 'HARNESS_RESEARCH.md', 'AGENT_KIT_RESEARCH.md', 'PUBLICAR_AGENT_KIT.md']) {
  const p = path.join(ROOT, doc);
  if (!fs.existsSync(p) || fs.statSync(p).size < 200) {
    fail(`ENG-13 violation: required documentation file ${doc} missing or empty`);
  }
}

// 3. Syntax-check every JS file in extension runtime
const jsDirs = ['shared', 'content', 'background', 'popup', 'livechat', 'dashboard', 'offscreen'];
let checkedJs = 0;
for (const d of jsDirs) {
  const dirPath = path.join(ROOT, d);
  if (!fs.existsSync(dirPath)) continue;
  for (const entry of fs.readdirSync(dirPath)) {
    if (!entry.endsWith('.js')) continue;
    const fp = path.join(dirPath, entry);
    execFileSync(process.execPath, ['--check', fp], { stdio: 'pipe' });
    checkedJs++;
  }
}

// 4. Static Security Invariants: zero direct_agent_git in UI/SW/content & zero plaintext githubToken reads from settings
const uiAndRuntimeDirs = ['popup', 'livechat', 'dashboard', 'background', 'content'];
for (const d of uiAndRuntimeDirs) {
  const dirPath = path.join(ROOT, d);
  for (const entry of fs.readdirSync(dirPath)) {
    if (!entry.endsWith('.js') && !entry.endsWith('.html')) continue;
    const fp = path.join(dirPath, entry);
    const src = fs.readFileSync(fp, 'utf8');
    if (src.includes('direct_agent_git')) {
      fail(`SEC-01 violation: legacy direct_agent_git found in ${d}/${entry}`);
    }
    if (/\b(s|st|settings|currentSettings)\.githubToken\b/.test(src)) {
      fail(`SEC-02 violation: plaintext settings.githubToken access found in ${d}/${entry}`);
    }
  }
}

console.log(`✅ [VERIFY OK] Manifest v${manifest.version}, CSP, Docs & ${checkedJs} JS modules verified cleanly.`);
