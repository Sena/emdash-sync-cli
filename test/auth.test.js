'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.EMDASH_SYNC_AUTO_LOGIN = '0'; // never open a login flow from tests

const auth = require('../lib/auth');

test('looksLikeAuthFailure: catches Cloudflare and EmDash auth errors', () => {
  assert.ok(auth.looksLikeAuthFailure('The given account is not valid or is not authorized to access this service [code: 7403]'));
  assert.ok(auth.looksLikeAuthFailure('[code: 10000] Invalid API Token'));
  assert.ok(auth.looksLikeAuthFailure('Authentication error [code: 9109]'));
  assert.ok(auth.looksLikeAuthFailure('You are not logged in. Please login.'));
});

test('looksLikeAuthFailure: leaves unrelated output alone', () => {
  assert.ok(!auth.looksLikeAuthFailure(''));
  assert.ok(!auth.looksLikeAuthFailure('Successfully exported 76 tables.'));
});

test('cloudflareAuthError: carries the fix command, the link and the specific error line', () => {
  const raw = [
    'Command failed: npx wrangler d1 execute my-db --remote --json --command "SELECT 1"',
    '{',
    '\t"error": {',
    '\t\t"text": "A request to the Cloudflare API (\\/accounts\\/abc\\/d1\\/database\\/def\\/query) failed.",',
    '\t\t"notes": [',
    '\t\t\t{',
    '\t\t\t\t"text": "The given account is not valid or is not authorized to access this service [code: 7403]"',
    '\t\t\t}',
    '\t\t],',
    '\t\t"kind": "error"',
    '\t}',
    '}',
  ].join('\n');

  const message = auth.cloudflareAuthError(raw).message;
  assert.match(message, /Cloudflare sign-in missing or expired/);
  assert.match(message, /npx wrangler login/);
  assert.match(message, /https:\/\/dash\.cloudflare\.com\/profile\/api-tokens/);
  assert.match(message, /Detail: The given account is not valid or is not authorized to access this service \[code: 7403\]/);
});

test('cloudflareAuthError: works with plain-text failures too', () => {
  const message = auth.cloudflareAuthError('Authentication error [code: 10000]\nInvalid API Token').message;
  assert.match(message, /Detail: Authentication error \[code: 10000\]/);
});

test('isInteractive: EMDASH_SYNC_AUTO_LOGIN=0 disables auto-login', () => {
  assert.equal(auth.isInteractive(), false);
});
