'use strict';

const ui = require('./ui');
const pull = require('./pull');
const push = require('./push');

// CLI entry: parses argv, resolves the command and dispatches.
// Commands are explicit -- `pull` (production → local) and `push` (local →
// production, schema only). With no command, the CLI prints the help.
// Convention: every command is a dry-run by default; `--apply` executes.

const COMMANDS = { pull, push };

const HELP = `🧭 EmDash Sync — pulls EVERYTHING from production to local; pushes ONLY schema from local to production.

Usage:
  emdash-sync pull [--apply] [--no-backup]
      Production → local. Brings everything: D1 database, R2 media, and the
      local state is rebuilt as a clone of production.

  emdash-sync push [--apply] [--seed=<file>] [--url=<url>]
      Local → production. Sends schema only: collections, fields, block types
      and taxonomies. Never content, terms, menus, widgets or settings.
      By default the schema is generated from the local database (source of truth).

  emdash-sync help

Commands are explicit: without one of pull/push/help nothing runs.
Without --apply every command is a dry-run: it prints the plan and changes nothing.

Flags:
  --apply            actually run (without it, dry-run)
  --no-backup        (pull) skip the local state backup before wiping
  --seed=<file>      (push) use a seed JSON file instead of generating from the local DB
  --url=<url>        (push) target instance (default: EMDASH_URL → SITE_URL → Cloudflare → EmDash session)
  -h, --help         show this help

Examples:
  emdash-sync pull                          # dry-run of the pull (production → local)
  emdash-sync pull --apply                  # run the pull
  emdash-sync push                          # dry-run of the schema push
  emdash-sync push --apply                  # send the schema to production
  emdash-sync push --apply --url http://localhost:4321`;

const BOOLEAN_FLAGS = new Set(['apply', 'no-backup', 'help']);
const VALUE_FLAGS = new Set(['url', 'seed']);

/** Parses argv: positionals (commands) and `--name` / `--name=value` flags. */
function parseArgs(argv) {
  const positionals = [];
  const flags = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') return { error: `Missing value for --${name}.` };
      flags.set(name, value);
      continue;
    }
    return { error: `Unknown flag: --${name}` };
  }

  return { positionals, flags };
}

/** Prints the help; `failed` marks the exit code as failure. */
function showHelp({ failed = false } = {}) {
  if (failed) process.exitCode = 1;
  ui.log(HELP);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    ui.fail(`❌ ${parsed.error}\n`);
    showHelp({ failed: true });
    return;
  }

  const { positionals, flags } = parsed;

  if (flags.get('help') || positionals[0] === 'help') {
    showHelp();
    return;
  }

  // Commands are explicit: nothing runs without one of pull/push.
  if (positionals.length === 0) {
    if (flags.size > 0) {
      ui.fail('❌ Missing command: use "emdash-sync pull" or "emdash-sync push".\n');
      showHelp({ failed: true });
      return;
    }
    showHelp();
    return;
  }

  const command = positionals[0];

  if (positionals.length > 1) {
    ui.fail(`❌ Unexpected argument: "${positionals[1]}"\n`);
    showHelp({ failed: true });
    return;
  }
  if (!COMMANDS[command]) {
    ui.fail(`❌ Unknown command: "${command}"\n`);
    showHelp({ failed: true });
    return;
  }
  if (command === 'pull' && (flags.has('seed') || flags.has('url'))) {
    ui.fail('❌ --seed and --url are only available for "push".\n');
    showHelp({ failed: true });
    return;
  }
  if (command === 'push' && flags.get('no-backup')) {
    ui.fail('❌ --no-backup is only available for "pull".\n');
    showHelp({ failed: true });
    return;
  }

  try {
    if (command === 'pull') {
      await pull.run({ apply: Boolean(flags.get('apply')), noBackup: Boolean(flags.get('no-backup')) });
    } else {
      await push.run({ apply: Boolean(flags.get('apply')), url: flags.get('url'), seed: flags.get('seed') });
    }
  } catch (error) {
    // Safety net: commands handle their own errors.
    ui.fail(`\n❌ Unexpected error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
