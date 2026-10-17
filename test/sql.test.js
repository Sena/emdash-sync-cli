'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { reorderDump } = require('../lib/sql');

test('reorderDump: pragmas and foreign_keys=OFF come first', () => {
  const out = reorderDump('INSERT INTO a VALUES (1);\nPRAGMA foreign_keys=ON;');
  assert.equal(out, 'PRAGMA foreign_keys=ON;\nPRAGMA foreign_keys=OFF;\nINSERT INTO a VALUES (1);');
});

test('reorderDump: CREATE TABLE before indexes/triggers and INSERTs', () => {
  const dump = [
    'INSERT INTO products (id) VALUES (1);',
    'CREATE INDEX idx_products ON products (id);',
    'CREATE TABLE products (id INTEGER);',
    'CREATE TABLE media (id INTEGER);',
  ].join('\n');

  assert.deepEqual(reorderDump(dump).split('\n'), [
    'PRAGMA foreign_keys=OFF;',
    'CREATE TABLE products (id INTEGER);',
    'CREATE TABLE media (id INTEGER);',
    'CREATE INDEX idx_products ON products (id);',
    'INSERT INTO products (id) VALUES (1);',
  ]);
});

test('reorderDump: blank lines and surrounding whitespace are dropped', () => {
  const out = reorderDump('\n  CREATE TABLE a (id INTEGER);  \n\nINSERT INTO a VALUES (1);\n');
  assert.equal(out, 'PRAGMA foreign_keys=OFF;\nCREATE TABLE a (id INTEGER);\nINSERT INTO a VALUES (1);');
});
