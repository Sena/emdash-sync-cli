'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Where the schema sent by `push` comes from. By default it is GENERATED from
// the local database (the project's source of truth): `npx emdash export-seed`
// reads the local D1 SQLite file directly, so push does not depend on a
// versioned seed file existing.
// `--seed=<file>` is still available to send a specific file (for example, a
// frozen seed from an earlier snapshot).

const D1_STATE_DIR = path.join('.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

/**
 * The most recent local D1 SQLite file (same pick the project snapshot uses).
 * `baseDir` lets tests point at a fixture directory.
 */
function findLocalDatabase(baseDir = '.') {
  const stateDir = path.join(baseDir, D1_STATE_DIR);
  if (!fs.existsSync(stateDir)) {
    throw new Error(
      `No local database at ${stateDir}. Run the pull (or the dev server) once, or use --seed=<file>.`,
    );
  }
  const files = fs
    .readdirSync(stateDir)
    .filter((name) => name.endsWith('.sqlite') && !name.startsWith('metadata'))
    .map((name) => ({ name, time: fs.statSync(path.join(stateDir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (!files.length) throw new Error(`No SQLite file in ${stateDir}.`);
  return path.join(stateDir, files[0].name);
}

/** Generates the seed from the local database — no content: push never sends data. */
function fromLocalDatabase() {
  const database = findLocalDatabase();
  const out = execFileSync('npx', ['emdash', 'export-seed', '--database', database], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 128 * 1024 * 1024,
  });
  const seed = JSON.parse(out);
  delete seed.content; // code-level guarantee: even if it comes, it never leaves here
  return { seed, source: `local database (${path.basename(database)})` };
}

/**
 * Loads the seed wanted by `push`.
 *
 * @param {string|undefined} explicitPath Path from `--seed`, when passed.
 * @returns {{ seed: object, source: string }}
 */
function loadSeed(explicitPath) {
  if (explicitPath) {
    const seed = JSON.parse(fs.readFileSync(explicitPath, 'utf8'));
    delete seed.content; // same: seed content is never sent
    return { seed, source: explicitPath };
  }
  return fromLocalDatabase();
}

module.exports = { loadSeed, findLocalDatabase };
