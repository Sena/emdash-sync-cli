'use strict';

/**
 * Reorders a SQL dump so the import does not violate Foreign Keys:
 * PRAGMAs → CREATE TABLE → everything else (indexes/triggers/views) → INSERTs,
 * with FK enforcement disabled.
 *
 * @param {string} content Original dump (one statement per line, as produced
 *                         by `wrangler d1 export`).
 * @returns {string} Reordered dump.
 */
function reorderDump(content) {
  const pragmas = [];
  const creates = [];
  const inserts = [];
  const others = [];

  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const upper = trimmed.toUpperCase();
    if (upper.startsWith('PRAGMA')) {
      pragmas.push(trimmed);
    } else if (upper.startsWith('CREATE TABLE')) {
      creates.push(trimmed);
    } else if (upper.startsWith('INSERT')) {
      inserts.push(trimmed);
    } else {
      others.push(trimmed); // CREATE INDEX, CREATE TRIGGER, VIEWS, etc.
    }
  });

  return [
    ...pragmas,
    'PRAGMA foreign_keys=OFF;',
    ...creates,
    ...others,
    ...inserts,
  ].join('\n');
}

module.exports = { reorderDump };
