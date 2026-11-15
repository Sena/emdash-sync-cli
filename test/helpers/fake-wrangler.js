#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// In-memory stand-in for the `wrangler` CLI, used by hermetic tests through
// EMDASH_WRANGLER_COMMAND. It answers only the calls the sync CLI makes:
//
//   d1 execute <db> --local|--remote --json --command "<sql>"
//   d1 execute <db> --local --file=<dump.sql>
//   d1 export  <db> --remote --table=<name>... --output=<dump.sql>
//   r2 object put <bucket>/<key> --file=<path> --local --content-type=<type>
//
// Everything is driven by FAKE_WRANGLER_DIR: state.json holds the fixture,
// calls.jsonl records every invocation, objects/ receives the R2 writes and
// the exported dump lands wherever the caller asked. No network, no
// credentials, no real project files.

const workDir = process.env.FAKE_WRANGLER_DIR;

if (!workDir) {
  process.stderr.write('fake-wrangler: FAKE_WRANGLER_DIR is required\n');
  process.exit(2);
}

const statePath = path.join(workDir, 'state.json');
const callsPath = path.join(workDir, 'calls.jsonl');

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
};

/** Appends one invocation to the transcript the tests assert against. */
function record(entry) {
  fs.appendFileSync(callsPath, `${JSON.stringify(entry)}\n`);
}

/** Flags that never take a value (`wrangler` accepts them bare). */
const BOOLEAN_FLAGS = new Set(['json', 'local', 'remote', 'force', 'yes', 'persist-to']);

/**
 * Splits argv into the command chain, positionals and flags. Wrangler accepts
 * both `--name=value` and `--name value`, and the CLI uses the spaced form for
 * `--command "<sql>"`, so a non-boolean flag consumes the next token.
 */
function parse(argv) {
  const positionals = [];
  const flags = new Map();

  const set = (name, value) => {
    const previous = flags.get(name);
    flags.set(name, previous === undefined ? value : [].concat(previous, value));
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    if (eq !== -1) {
      set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }

    const name = arg.slice(2);
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      set(name, next);
      i += 1;
      continue;
    }
    set(name, true);
  }

  return { positionals, flags };
}

/** Answers the `d1 execute --json --command` queries the CLI depends on. */
function answerQuery(sql, state) {
  const text = String(sql);

  if (/count\(\*\)/i.test(text) && /\bfrom\s+media\b/i.test(text)) {
    return [{ n: (state.media ?? []).length }];
  }
  if (/\bfrom\s+media\b/i.test(text)) {
    return state.media ?? [];
  }
  if (/\bfrom\s+options\b/i.test(text)) {
    return state.siteUrl ? [{ value: JSON.stringify(state.siteUrl) }] : [];
  }
  if (/sqlite_master/i.test(text)) {
    return (state.tables ?? []).map((name) => ({ name }));
  }
  return [];
}

function runD1({ positionals, flags }) {
  const action = positionals[1];
  const dbName = positionals[2];

  if (action === 'export') {
    const output = flags.get('output');
    const tables = [].concat(flags.get('table') ?? []);

    record({ command: 'd1 export', db: dbName, remote: Boolean(flags.get('remote')), tables, output });
    fs.writeFileSync(output, tables.map((table) => `CREATE TABLE ${table} (id TEXT);`).join('\n'));
    return 0;
  }

  if (action === 'execute') {
    if (flags.has('file')) {
      const file = flags.get('file');
      const bytes = fs.existsSync(file) ? fs.statSync(file).size : -1;
      record({ command: 'd1 execute', db: dbName, local: Boolean(flags.get('local')), file, bytes });
      if (bytes < 0) {
        process.stderr.write(`fake-wrangler: import file not found: ${file}\n`);
        return 1;
      }
      return 0;
    }

    const sql = flags.get('command');
    const results = answerQuery(sql, readState());
    record({ command: 'd1 execute', db: dbName, remote: Boolean(flags.get('remote')), sql, rows: results.length });
    process.stdout.write(JSON.stringify([{ results }]));
    return 0;
  }

  process.stderr.write(`fake-wrangler: unsupported d1 action: ${action}\n`);
  return 1;
}

function runR2({ positionals, flags }) {
  if (positionals[1] !== 'object' || positionals[2] !== 'put') {
    process.stderr.write(`fake-wrangler: unsupported r2 command: ${positionals.join(' ')}\n`);
    return 1;
  }

  const target = positionals[3] ?? '';
  const separator = target.indexOf('/');
  const bucket = separator === -1 ? target : target.slice(0, separator);
  const key = separator === -1 ? '' : target.slice(separator + 1);
  const source = flags.get('file');
  const contentType = flags.get('content-type');

  if (!source || !fs.existsSync(source)) {
    process.stderr.write(`fake-wrangler: source file not found: ${source}\n`);
    return 1;
  }

  const destination = path.join(workDir, 'objects', bucket, key);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  record({ command: 'r2 object put', bucket, key, contentType, bytes: fs.statSync(destination).size, local: Boolean(flags.get('local')) });
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const parsed = parse(argv);

  if (parsed.positionals[0] === 'd1') return runD1(parsed);
  if (parsed.positionals[0] === 'r2') return runR2(parsed);

  process.stderr.write(`fake-wrangler: unsupported command: ${argv.join(' ')}\n`);
  return 1;
}

process.exitCode = main();
