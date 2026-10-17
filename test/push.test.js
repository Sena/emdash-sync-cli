'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startFakeEmdash } = require('./helpers/fake-emdash');
const { runCli } = require('./helpers/run-cli');

const SEED = {
  collections: [
    {
      slug: 'products',
      label: 'Products',
      labelSingular: 'Product',
      supports: ['titles'],
      titleField: 'title',
      fields: [
        { slug: 'title', label: 'Title', type: 'text', required: true },
        { slug: 'price', label: 'Price', type: 'number', validation: { min: 0 } },
      ],
    },
  ],
  taxonomies: [
    { name: 'brand', label: 'Brands', labelSingular: 'Brand', collections: ['products'] },
  ],
};

function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-push-'));
  fs.mkdirSync(path.join(dir, 'seed'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'seed', 'schema.json'), JSON.stringify(SEED));
  return dir;
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('push (dry-run): prints the plan and writes nothing to the target', async () => {
  const fake = await startFakeEmdash();
  const dir = makeProjectDir();
  try {
    const result = await runCli(['push', '--url', fake.url, '--seed', 'seed/schema.json'], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\(dry-run\)/);
    assert.match(result.stdout, /· create collection products/);
    assert.match(result.stdout, /· create field products\.price \(number\)/);
    assert.match(result.stdout, /· create taxonomy brand/);
    assert.match(result.stdout, /5 step\(s\) planned/);
    assert.equal(fake.writes().length, 0);
  } finally {
    cleanup(dir);
    await fake.close();
  }
});

test('push --apply: executes the steps and is idempotent on a second run', async () => {
  const fake = await startFakeEmdash();
  const dir = makeProjectDir();
  try {
    const first = await runCli(['push', '--apply', '--url', fake.url, '--seed', 'seed/schema.json'], { cwd: dir });

    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /✔ create collection products/);
    assert.match(first.stdout, /✔ create taxonomy brand/);
    assert.equal(fake.state.collections.has('products'), true);
    assert.equal(fake.state.taxonomies.has('brand'), true);
    assert.ok(fake.writes().length >= 5);

    const second = await runCli(['push', '--apply', '--url', fake.url, '--seed', 'seed/schema.json'], { cwd: dir });

    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Nothing to do/);
  } finally {
    cleanup(dir);
    await fake.close();
  }
});

test('push: EMDASH_URL steers the target when --url is omitted', async () => {
  const fake = await startFakeEmdash();
  const dir = makeProjectDir();
  try {
    const result = await runCli(['push', '--seed', 'seed/schema.json'], {
      cwd: dir,
      env: { EMDASH_URL: fake.url },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\(via EMDASH_URL\)/);
    assert.match(result.stdout, /· create collection products/);
  } finally {
    cleanup(dir);
    await fake.close();
  }
});

test('push: a missing seed fails before touching the target', async () => {
  const fake = await startFakeEmdash();
  const dir = makeProjectDir();
  try {
    const result = await runCli(['push', '--apply', '--url', fake.url, '--seed', 'seed/missing.json'], { cwd: dir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not build the schema to push/);
    assert.equal(fake.requests.length, 0);
  } finally {
    cleanup(dir);
    await fake.close();
  }
});

test('push: a content payload in the seed is stripped and never sent', async () => {
  const fake = await startFakeEmdash();
  const dir = makeProjectDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'seed', 'schema.json'),
      JSON.stringify({ ...SEED, content: [{ type: 'paragraph' }] }),
    );

    const result = await runCli(['push', '--apply', '--url', fake.url, '--seed', 'seed/schema.json'], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.ok(fake.writes().every((request) => !JSON.stringify(request.body ?? {}).includes('paragraph')));
    assert.equal(fake.state.collections.has('products'), true);
  } finally {
    cleanup(dir);
    await fake.close();
  }
});
