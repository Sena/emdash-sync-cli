'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.EMDASH_SYNC_AUTO_LOGIN = '0';
delete process.env.EMDASH_TOKEN;
delete process.env.EMDASH_COOKIE;

const { createClient } = require('../lib/api');
const { startFakeEmdash } = require('./helpers/fake-emdash');

test('createClient: on localhost the dev-bypass grants the session', async () => {
  const fake = await startFakeEmdash();
  try {
    const api = await createClient(fake.url);
    const data = await api.request('GET', '/_emdash/api/schema/collections');
    assert.deepEqual(data, []);
    assert.ok(fake.requests.some((request) => request.path === '/_emdash/api/auth/dev-bypass'));
  } finally {
    await fake.close();
  }
});

test('request: a rejected bearer token falls back to the dev-bypass cookie', async () => {
  const fake = await startFakeEmdash({ token: 'good-token' });
  process.env.EMDASH_TOKEN = 'stale-token';
  try {
    const api = await createClient(fake.url);
    const data = await api.request('GET', '/_emdash/api/schema/collections');
    assert.deepEqual(data, []);
    assert.ok(fake.requests.some((request) => request.path === '/_emdash/api/auth/dev-bypass'));
  } finally {
    delete process.env.EMDASH_TOKEN;
    await fake.close();
  }
});

test('createClient: a remote target without any session points at the fix command', async () => {
  await assert.rejects(
    createClient('https://shop.example.invalid'),
    /No EmDash admin session for https:\/\/shop\.example\.invalid/,
  );
});

test('createClient: a missing local dev server produces a clear error', async () => {
  // Grab a port that is guaranteed closed on this machine.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  await assert.rejects(createClient(`http://127.0.0.1:${port}`), /No EmDash dev server answering at/);
});

test('request: API error responses include method, endpoint and status', async () => {
  const fake = await startFakeEmdash();
  try {
    const api = await createClient(fake.url);
    await assert.rejects(api.request('GET', '/_emdash/api/nope'), /GET \/_emdash\/api\/nope -> 404/);
  } finally {
    await fake.close();
  }
});
