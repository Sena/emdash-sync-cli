'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Discovers the production site's public URL without versioning it (ported
// from mini-commerce's `scripts/site-url.mjs`). The production domain is never
// committed to a file; resolution tries, in order:
//
//   1. SITE_URL environment variable (or EMDASH_SITE_URL);
//   2. SITE_URL in the project's .env / .env.local;
//   3. Cloudflare — this repository's Worker custom domain, read from
//      wrangler.jsonc/json/toml, using the wrangler OAuth credential (renews
//      itself via `npx wrangler whoami` when the token expired);
//   4. EmDash CLI session (~/.config/emdash/auth.json), when there is only one.

const ENV_KEYS = ['SITE_URL', 'EMDASH_SITE_URL'];
const WRANGLER_FILES = [
  ['wrangler.jsonc', /"name"\s*:\s*"([^"]+)"/],
  ['wrangler.json', /"name"\s*:\s*"([^"]+)"/],
  ['wrangler.toml', /^\s*name\s*=\s*"([^"]+)"/m],
];

const normalize = (value) => String(value ?? '').trim().replace(/\/+$/, '');

/** 1. Environment variables. */
function fromEnvironment() {
  for (const key of ENV_KEYS) {
    const url = normalize(process.env[key]);
    if (url) return { url, source: `environment (${key})` };
  }
  return null;
}

/** 2. Project .env / .env.local files. */
function fromEnvFile(cwd) {
  for (const file of ['.env', '.env.local']) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(SITE_URL|EMDASH_SITE_URL)\s*=\s*"?([^"\s#]+)"?/);
      if (match) return { url: normalize(match[2]), source: file };
    }
  }
  return null;
}

/** Worker name declared in the wrangler config. */
function workerName(cwd) {
  for (const [file, pattern] of WRANGLER_FILES) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) continue;
    const match = fs.readFileSync(full, 'utf8').match(pattern);
    if (match) return match[1];
  }
  return '';
}

/** Possible wrangler config paths (Windows and POSIX). */
function wranglerConfigPaths() {
  const roots = [
    process.env.XDG_CONFIG_HOME,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    path.join(os.homedir(), '.config'),
    os.homedir(),
  ].filter(Boolean);
  const paths = [];
  for (const root of roots) {
    paths.push(path.join(root, '.wrangler', 'config', 'default.toml'));
    // Some wrangler versions use an xdg.config directory inside AppData.
    paths.push(path.join(root, 'xdg.config', '.wrangler', 'config', 'default.toml'));
  }
  return [...new Set(paths)];
}

function wranglerToken() {
  for (const file of wranglerConfigPaths()) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return '';
}

async function cloudflareApi(pathname, token) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const error = new Error(`HTTP ${res.status} at ${pathname}`);
    error.status = res.status;
    throw error;
  }
  return body.result ?? [];
}

/** 3. This repository's Worker custom domain, straight from Cloudflare. */
async function fromCloudflare(cwd) {
  let token = wranglerToken();
  if (!token) throw new Error('wrangler credential not found (run `npx wrangler login`)');

  const listDomains = async () => {
    const domains = [];
    for (const account of await cloudflareApi('/accounts', token)) {
      domains.push(...(await cloudflareApi(`/accounts/${account.id}/workers/domains?per_page=100`, token)));
    }
    return domains;
  };

  let domains;
  try {
    domains = await listDomains();
  } catch (error) {
    // Expired token: any wrangler command renews and rewrites the credential.
    if (error.status !== 401 && error.status !== 403) throw error;
    execFileSync('npx', ['wrangler', 'whoami'], { stdio: 'ignore', shell: process.platform === 'win32' });
    token = wranglerToken();
    domains = await listDomains();
  }

  const name = workerName(cwd);
  const ofWorker = domains.filter((domain) => name && domain.service === name);
  const pool = (ofWorker.length ? ofWorker : domains).filter(
    (domain) => domain.hostname && !domain.hostname.endsWith('.workers.dev'),
  );
  const preferred = pool.filter((domain) => !domain.environment || domain.environment === 'production');
  const hosts = [...new Set((preferred.length ? preferred : pool).map((domain) => domain.hostname))];

  if (hosts.length === 0) throw new Error(`no custom domain found for the Worker${name ? ` ${name}` : ''}`);
  if (hosts.length > 1) {
    throw new Error(`Worker with more than one domain (${hosts.join(', ')}) — set SITE_URL to choose`);
  }
  return { url: `https://${hosts[0]}`, source: `Cloudflare (Worker ${name || '?'})` };
}

/** 4. EmDash CLI sessions: the auth.json keys are the site URLs. */
function emdashAuthSites() {
  const file = path.join(os.homedir(), '.config', 'emdash', 'auth.json');
  try {
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).map(normalize).filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolves the production URL: returns `{ url, source }` or throws with what was missing. */
async function resolveSiteUrl({ cwd = process.cwd() } = {}) {
  const direct = fromEnvironment() ?? fromEnvFile(cwd);
  if (direct) return direct;

  const notes = [];
  try {
    return await fromCloudflare(cwd);
  } catch (error) {
    notes.push(`Cloudflare: ${error.message}`);
  }

  const sites = emdashAuthSites();
  if (sites.length === 1) return { url: sites[0], source: 'EmDash CLI session' };
  if (sites.length > 1) notes.push(`EmDash CLI session: ${sites.length} sites (${sites.join(', ')}) — ambiguous`);

  throw new Error(
    [
      'Could not determine the production URL.',
      ...notes.map((note) => `  - ${note}`),
      'Set SITE_URL (environment or .env) and try again.',
    ].join('\n'),
  );
}

module.exports = { resolveSiteUrl };
