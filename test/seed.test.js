'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findLocalDatabase, loadSeed } = require('../lib/seed');

const D1_STATE_DIR = path.join('.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-seed-'));
  fs.mkdirSync(path.join(dir, D1_STATE_DIR), { recursive: true });
  return dir;
}

const d1Path = (dir, name) => path.join(dir, D1_STATE_DIR, name);

test('findLocalDatabase: picks the most recent .sqlite file (metadata excluded)', () => {
  const dir = makeProjectDir();
  try {
    fs.writeFileSync(d1Path(dir, 'old.sqlite'), '');
    fs.writeFileSync(d1Path(dir, 'new.sqlite'), '');
    fs.writeFileSync(d1Path(dir, 'metadata.sqlite'), '{}');
    fs.writeFileSync(d1Path(dir, 'notes.txt'), '');
    fs.utimesSync(d1Path(dir, 'old.sqlite'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    fs.utimesSync(d1Path(dir, 'new.sqlite'), new Date(2021, 0, 1), new Date(2021, 0, 1));

    assert.equal(findLocalDatabase(dir), d1Path(dir, 'new.sqlite'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLocalDatabase: explains what to do when the state directory is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-seed-'));
  try {
    assert.throws(() => findLocalDatabase(dir), /No local database .* --seed=<file>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLocalDatabase: errors when the directory has no database file', () => {
  const dir = makeProjectDir();
  try {
    fs.writeFileSync(d1Path(dir, 'metadata.sqlite'), '{}');
    assert.throws(() => findLocalDatabase(dir), /No SQLite file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSeed: --seed loads the file and strips any content payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-seed-'));
  try {
    const file = path.join(dir, 'frozen.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ collections: [{ slug: 'products' }], content: [{ type: 'paragraph' }] }),
    );

    const { seed, source } = loadSeed(file);
    assert.equal(source, file);
    assert.equal(seed.content, undefined);
    assert.deepEqual(seed.collections, [{ slug: 'products' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
