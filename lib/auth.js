'use strict';

const { execFileSync } = require('child_process');

const ui = require('./ui');

// Credential failure detection and one-step recovery for the two systems this
// CLI touches: Cloudflare/wrangler (pull remote reads, production site
// discovery) and the EmDash admin session (push). Guiding rule: a broken
// credential must never surface as a raw command error — in interactive
// terminals the CLI opens the login flow and retries by itself; everywhere
// else the message carries the exact command and link to fix it.

// Output patterns that indicate missing or expired credentials. Cloudflare API
// codes: 10000 (invalid token), 9109 (unauthorized), 7403 (account not
// authorized — usually a credential from another account).
const AUTH_PATTERNS = [
  /not authorized/i,
  /unauthori[sz]ed/i,
  /authentication error/i,
  /\b(10000|9109|7403)\b/,
  /invalid.*(token|credential|api key)/i,
  /not logged in/i,
  /please log ?in/i,
  /oauth.*(expired|invalid)/i,
];

/** Whether the given output looks like a missing/expired credential failure. */
function looksLikeAuthFailure(text) {
  const value = String(text ?? '');
  return value.length > 0 && AUTH_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Whether the CLI is attached to an interactive terminal (and auto-login was
 * not disabled with EMDASH_SYNC_AUTO_LOGIN=0, which scripts and CI can use).
 */
const isInteractive = () =>
  process.env.EMDASH_SYNC_AUTO_LOGIN !== '0' && Boolean(process.stdout.isTTY && process.stdin.isTTY);

/** First meaningful line of a failure output (keeps messages compact). */
function firstLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Command failed:') && !/^[{}\[\],]+$/.test(line));

  // Prefer the most specific line: the one carrying a Cloudflare error code,
  // then wrangler's JSON "text" fields, then anything mentioning a failure.
  const pick =
    lines.find((line) => /\[code:\s*\d+\]/.test(line)) ??
    lines.find((line) => /^"text":/.test(line)) ??
    lines.find((line) => /error|failed|invalid|unauthori|not authorized|expired/i.test(line)) ??
    lines[0] ??
    '';

  return pick
    .replace(/^"text":\s*"/, '') // unwrap wrangler's JSON error shape
    .replace(/",?$/, '')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Actionable error for missing/expired Cloudflare (wrangler) credentials. */
function cloudflareAuthError(detail) {
  const line = firstLine(detail);
  return new Error(
    [
      'Cloudflare sign-in missing or expired.',
      'Fix: npx wrangler login          (it opens the browser; click "Allow")',
      'Wrong account? npx wrangler logout, then login again. Manual tokens: https://dash.cloudflare.com/profile/api-tokens',
      line ? `Detail: ${line.slice(0, 200)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** Runs an interactive login; returns true when it completed. */
function runLogin(command, args) {
  try {
    execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    return true;
  } catch {
    return false;
  }
}

/** Opens the interactive Cloudflare login (browser + consent click). */
function launchCloudflareLogin() {
  ui.warn('🔐 Cloudflare sign-in missing or expired — opening the login flow; click "Allow" in the browser...');
  return runLogin('npx', ['wrangler', 'login']);
}

/** Opens the interactive EmDash admin login for the given URL. */
function launchEmdashLogin(url) {
  ui.warn(`🔐 No EmDash admin session for ${url} — opening the login flow...`);
  return runLogin('npx', ['emdash', 'login', '--url', url]);
}

module.exports = { looksLikeAuthFailure, isInteractive, cloudflareAuthError, launchCloudflareLogin, launchEmdashLogin };
