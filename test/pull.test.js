'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startFakeEmdash } = require('./helpers/fake-emdash');
const { runCli } = require('./helpers/run-cli');

// End-to-end coverage for `pull`, the command that had no automated test: it
// used to be "validated manually" against a real Cloudflare account. Wrangler is
// the only external dependency, and it is reached through a single choke point,
// so EMDASH_WRANGLER_COMMAND swaps in test/helpers/fake-wrangler.js. Media comes
// from the fake EmDash server on 127.0.0.1. Nothing here touches a real site,
// a real bucket or real credentials.

const FAKE_WRANGLER = path.join(__dirname, 'helpers', 'fake-wrangler.js').replace(/\\/g, '/');
const QUERY_PORT = '65123';

const MEDIA_ROWS = [
  { id: '01AAAAAAAAAAAAAAAAAAAAAAAA', mime_type: 'image/webp', storage_key: 'plain-1.webp' },
  { id: '01BBBBBBBBBBBBBBBBBBBBBBBB', mime_type: 'image/webp', storage_key: 'plain-2.webp' },
  { id: '01CCCCCCCCCCCCCCCCCCCCCCCC', mime_type: 'image/webp', storage_key: 'deleted.webp' },
  { id: '01DDDDDDDDDDDDDDDDDDDDDDDD', mime_type: 'image/webp', storage_key: 'broken.webp' },
  { id: '01EEEEEEEEEEEEEEEEEEEEEEEE', mime_type: 'image/webp', storage_key: 'flaky.webp' },
];

const MEDIA_FILES = {
  'plain-1.webp': { body: 'plain-one', delayMs: 80 },
  'plain-2.webp': { body: 'plain-two', delayMs: 80 },
  'deleted.webp': { status: 404 },
  'broken.webp': { status: 500 },
  'flaky.webp': { body: 'flaky-body', failures: 1 },
};

/** A throwaway project: wrangler config plus leftover local emulator state. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-pull-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });

  fs.writeFileSync(
    path.join(project, 'wrangler.jsonc'),
    `{
  "d1_databases": [{ "binding": "DB", "database_name": "fake-db", "database_id": "fake-id" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "fake-bucket" }]
}
`,
  );

  // Local state from a previous session, to prove the wipe really happens.
  for (const dir of ['d1', 'r2']) {
    const stale = path.join(project, '.wrangler', 'state', 'v3', dir);
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'stale.txt'), 'local data that must not survive');
  }

  return { root, project };
}

/** Fixture the fake wrangler reads on every call. */
function makeWranglerState(root, siteUrl) {
  const dir = path.join(root, 'wrangler');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      siteUrl,
      media: MEDIA_ROWS,
      // `sqlite_sequence` is internal and must be filtered out of the export.
      tables: ['media', 'options', '_emdash_collections', 'sqlite_sequence'],
    }),
  );
  return dir;
}

const readCalls = (dir) => {
  const file = path.join(dir, 'calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const objectPath = (dir, bucket, key) => path.join(dir, 'objects', bucket, key);

const env = (wranglerDir) => ({
  EMDASH_WRANGLER_COMMAND: `node "${FAKE_WRANGLER}"`,
  FAKE_WRANGLER_DIR: wranglerDir,
  EMDASH_SYNC_CONCURRENCY: '3',
  EMDASH_SYNC_DEV_PORT: QUERY_PORT,
});

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('pull --apply: exports, imports, mirrors the media that still exists and sanitizes', async () => {
  const fake = await startFakeEmdash({ media: MEDIA_FILES });
  const { root, project } = makeProject();
  const wranglerDir = makeWranglerState(root, fake.url);

  try {
    const result = await runCli(['pull', '--apply', '--no-backup'], { cwd: project, env: env(wranglerDir) });

    // One file could not be mirrored, so the command must not report a clean
    // clone: it exits non-zero even though the sync itself completed.
    assert.equal(result.code, 1, result.stdout);

    // The media that is still in production lands in the bucket, byte for byte.
    for (const [key, expected] of [
      ['plain-1.webp', 'plain-one'],
      ['plain-2.webp', 'plain-two'],
      ['flaky.webp', 'flaky-body'],
    ]) {
      const file = objectPath(wranglerDir, 'fake-bucket', key);
      assert.equal(fs.existsSync(file), true, `${key} was not written to the local R2`);
      assert.equal(fs.readFileSync(file, 'utf-8'), expected);
    }

    // 404 is gone for good (skipped), 500 survives the retries (failed), and the
    // flaky one is retried into success instead of being given up on.
    assert.equal(fs.existsSync(objectPath(wranglerDir, 'fake-bucket', 'deleted.webp')), false);
    assert.equal(fs.existsSync(objectPath(wranglerDir, 'fake-bucket', 'broken.webp')), false);
    assert.match(result.stdout, /In database: 5 · downloaded: 3 · skipped: 1 · failed: 1/);
    assert.match(result.stderr, /Local R2 may be incomplete/);
    assert.match(result.stderr, /NOT identical to production/);
    assert.doesNotMatch(result.stdout, /identical to production/);

    // Downloads really overlapped: the pool keeps several requests in flight.
    assert.ok(fake.mediaStats.maxInFlight >= 2, `expected concurrent downloads, max in flight was ${fake.mediaStats.maxInFlight}`);
    assert.equal(fake.media.get('flaky.webp').hits, 2, 'the retry should hit the file exactly twice');

    // A 404 is reported as skipped, never downloaded; the 500 is the failure.
    assert.match(result.stderr, /\[Skipped\] Failed to download deleted\.webp \(Status: 404\)/);
    assert.match(result.stderr, /Error processing broken\.webp: HTTP 500/);

    const calls = readCalls(wranglerDir);
    const exported = calls.find((call) => call.command === 'd1 export');
    assert.ok(exported, 'the remote D1 was never exported');
    assert.deepEqual(exported.tables, ['media', 'options', '_emdash_collections']);
    assert.equal(exported.remote, true);

    const imported = calls.find((call) => call.command === 'd1 execute' && call.file);
    assert.ok(imported, 'the dump was never imported');
    assert.ok(imported.bytes > 0, 'the dump was empty at import time');

    const siteUrlQuery = calls.find((call) => call.command === 'd1 execute' && /from options/i.test(call.sql ?? ''));
    assert.equal(siteUrlQuery.remote, true, 'the production URL must be read read-only');

    // Sanitization: the dump does not survive, and the stale local state is gone.
    assert.equal(fs.existsSync(path.join(project, 'dump.sql')), false);
    assert.equal(fs.existsSync(path.join(project, '.wrangler', 'state', 'v3', 'd1', 'stale.txt')), false);
    assert.equal(fs.existsSync(path.join(project, '.wrangler', 'state', 'v3', 'r2', 'stale.txt')), false);
  } finally {
    cleanup(root);
    await fake.close();
  }
});

test('pull --apply: a complete clone exits 0 and says so', async () => {
  const fake = await startFakeEmdash({
    media: { 'plain-1.webp': { body: 'plain-one' }, 'plain-2.webp': { body: 'plain-two' } },
  });
  const { root, project } = makeProject();
  const wranglerDir = makeWranglerState(root, fake.url);

  // Only the two files that are actually served, so every record mirrors.
  fs.writeFileSync(
    path.join(wranglerDir, 'state.json'),
    JSON.stringify({
      siteUrl: fake.url,
      media: MEDIA_ROWS.slice(0, 2),
      tables: ['media', 'options', '_emdash_collections', 'sqlite_sequence'],
    }),
  );

  try {
    const result = await runCli(['pull', '--apply', '--no-backup'], { cwd: project, env: env(wranglerDir) });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /In database: 2 · downloaded: 2 · skipped: 0 · failed: 0/);
    assert.match(result.stdout, /Sync 100% complete!/);
    assert.equal(fs.readFileSync(objectPath(wranglerDir, 'fake-bucket', 'plain-2.webp'), 'utf-8'), 'plain-two');
  } finally {
    cleanup(root);
    await fake.close();
  }
});

test('pull (dry-run): reads production, writes nothing locally, touches no media', async () => {
  const fake = await startFakeEmdash({ media: MEDIA_FILES });
  const { root, project } = makeProject();
  const wranglerDir = makeWranglerState(root, fake.url);

  try {
    const result = await runCli(['pull'], { cwd: project, env: env(wranglerDir) });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Dry-run: nothing was changed/);

    const calls = readCalls(wranglerDir);
    assert.ok(calls.length > 0, 'the dry-run should still read production');
    assert.equal(calls.filter((call) => call.command === 'd1 export').length, 0);
    assert.equal(calls.filter((call) => call.file).length, 0);
    assert.equal(calls.filter((call) => call.command === 'r2 object put').length, 0);

    assert.equal(fake.mediaStats.requests.length, 0, 'the dry-run must not download media');
    assert.equal(fs.existsSync(path.join(project, 'dump.sql')), false);
    // Local state is left exactly as it was.
    assert.equal(fs.existsSync(path.join(project, '.wrangler', 'state', 'v3', 'd1', 'stale.txt')), true);
  } finally {
    cleanup(root);
    await fake.close();
  }
});
