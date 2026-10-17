'use strict';

/**
 * Reordena um dump SQL para a importação não violar Foreign Keys:
 * PRAGMAs → CREATE TABLE → demais (índices/triggers/views) → INSERTs,
 * desabilitando FK durante a execução.
 *
 * @param {string} content Dump original (uma instrução por linha, como o
 *                         `wrangler d1 export` produz).
 * @returns {string} Dump reordenado.
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
      others.push(trimmed); // CREATE INDEX, CREATE TRIGGER, VIEWS, etc
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
