'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../lib/ui');
const { resolveTables, FALLBACK_TABLES } = require('../lib/tables');

// resolveTables prints discovery progress and warnings; keep the test output clean.
let restoreOutput;
before(() => {
  const { log, warn } = ui;
  ui.log = () => {};
  ui.warn = () => {};
  restoreOutput = () => {
    ui.log = log;
    ui.warn = warn;
  };
});
after(() => restoreOutput());

test('resolveTables: filters internal, Cloudflare and FTS tables', () => {
  // Real naming: the FTS index lives in `_emdash_fts_<collection>` + shadows.
  const query = () => [
    'products',
    'media',
    'sqlite_sequence',
    '_cf_KV',
    '_emdash_fts_products',
    '_emdash_fts_products_data',
    '_emdash_fts_products_idx',
  ];
  assert.deepEqual(resolveTables('db', { query, retryDelayMs: 0 }), ['products', 'media']);
});

test('resolveTables: retries transient failures before succeeding', () => {
  let calls = 0;
  const query = () => {
    calls += 1;
    if (calls < 3) throw new Error('transient');
    return ['products'];
  };

  assert.deepEqual(resolveTables('db', { query, attempts: 3, retryDelayMs: 0 }), ['products']);
  assert.equal(calls, 3);
});

test('resolveTables: falls back to the fixed list after repeated failures', () => {
  const query = () => {
    throw new Error('down');
  };
  assert.deepEqual(resolveTables('db', { query, attempts: 2, retryDelayMs: 0 }), FALLBACK_TABLES);
});

test('resolveTables: an empty discovery result also retries and falls back', () => {
  const query = () => [];
  assert.deepEqual(resolveTables('db', { query, attempts: 2, retryDelayMs: 0 }), FALLBACK_TABLES);
});

test('FALLBACK_TABLES: covers the tables the CLI depends on (BUG-007 regression)', () => {
  for (const table of ['media', 'media_folders', 'options', 'revisions']) {
    assert.ok(FALLBACK_TABLES.includes(table), `FALLBACK_TABLES is missing ${table}`);
  }
});

test('FALLBACK_TABLES: has no duplicates', () => {
  assert.equal(new Set(FALLBACK_TABLES).size, FALLBACK_TABLES.length);
});
