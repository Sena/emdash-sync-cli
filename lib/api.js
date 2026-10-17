'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// EmDash admin API client (ported from mini-commerce's
// `scripts/sync-schema-remote.mjs`). Authentication: Bearer token
// (EMDASH_TOKEN or the token saved by `npx emdash login`), a dev-bypass
// cookie on localhost, and automatic renewal when the token expires.

const AUTH_FILE = path.join(os.homedir(), '.config', 'emdash', 'auth.json');

/** Creates the HTTP client for an EmDash instance (local or remote). */
async function createClient(url) {
  const baseUrl = String(url).replace(/\/+$/, '');
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl);

  const storedToken = () => {
    try {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))[baseUrl]?.accessToken;
    } catch {
      return undefined;
    }
  };

  let token = process.env.EMDASH_TOKEN || storedToken();
  let cookie = process.env.EMDASH_COOKIE;

  /** In development EmDash grants a session without credentials. */
  async function devBypass() {
    const res = await fetch(`${baseUrl}/_emdash/api/auth/dev-bypass`, { redirect: 'manual' });
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    cookie = cookies.map((entry) => entry.split(';')[0]).join('; ');
    if (!cookie) throw new Error(`Dev bypass returned no session (HTTP ${res.status}).`);
  }

  if (!token && !cookie) {
    if (!isLocal) {
      throw new Error(`No token. Run \`npx emdash login --url ${baseUrl}\` or set EMDASH_TOKEN.`);
    }
    await devBypass();
  }

  const authHeaders = () => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  });

  // The CLI refreshes the access token and persists it; we use it when ours expires.
  function refreshToken() {
    execFileSync('npx', ['emdash', 'schema', 'list', '--url', baseUrl, '--json'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    token = storedToken();
  }

  /** Calls the API; returns `json.data` and throws when the response is not ok. */
  async function request(method, endpoint, body) {
    const send = () =>
      fetch(baseUrl + endpoint, {
        method,
        headers: {
          ...authHeaders(),
          // Cookie sessions (dev) require this header against CSRF.
          'X-EmDash-Request': '1',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    let res = await send();
    if (res.status === 401) {
      if (isLocal && !process.env.EMDASH_COOKIE) await devBypass();
      else if (token && !process.env.EMDASH_TOKEN) refreshToken();
      res = await send();
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok || json.success === false) {
      throw new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    return json.data ?? json;
  }

  return { request };
}

module.exports = { createClient };
