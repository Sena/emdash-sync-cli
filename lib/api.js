'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auth = require('./auth');

// EmDash admin API client (ported from mini-commerce's
// `scripts/sync-schema-remote.mjs`). Authentication: Bearer token
// (EMDASH_TOKEN or the token saved by `npx emdash login`), a dev-bypass
// cookie on localhost, and automatic renewal when the token expires.
// Credential problems surface with a fix, and interactive terminals can open
// the EmDash login flow directly.

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
    let res;
    try {
      res = await fetch(`${baseUrl}/_emdash/api/auth/dev-bypass`, { redirect: 'manual' });
    } catch {
      throw new Error(`No EmDash dev server answering at ${baseUrl}. Start it with \`npm run dev\` and try again.`);
    }
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    cookie = cookies.map((entry) => entry.split(';')[0]).join('; ');
    if (!cookie) {
      throw new Error(`Dev bypass returned no session (HTTP ${res.status}). Is the dev server fully started at ${baseUrl}?`);
    }
  }

  if (!token && !cookie) {
    if (!isLocal) {
      if (auth.isInteractive() && auth.launchEmdashLogin(baseUrl)) {
        token = process.env.EMDASH_TOKEN || storedToken();
      }
      if (!token) {
        throw new Error(
          `No EmDash admin session for ${baseUrl}. Fix: npx emdash login --url ${baseUrl} (opens the browser) or set EMDASH_TOKEN.`,
        );
      }
    } else {
      await devBypass();
    }
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

      // Remote target still unauthorized: offer the interactive login once.
      if (res.status === 401 && !isLocal && !process.env.EMDASH_TOKEN && auth.isInteractive() && auth.launchEmdashLogin(baseUrl)) {
        token = storedToken();
        res = await send();
      }
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok || json.success === false) {
      const detail = `${method} ${endpoint} -> ${res.status}: ${text.slice(0, 400)}`;
      if (res.status === 401) {
        throw new Error(`${detail}\nAuthentication failed. Fix: npx emdash login --url ${baseUrl} (or set EMDASH_TOKEN) and try again.`);
      }
      throw new Error(detail);
    }
    return json.data ?? json;
  }

  return { request };
}

module.exports = { createClient };
