'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const auth = require('./auth');

// Thin wrappers around the Wrangler CLI. Single choke point for every
// `wrangler` invocation — remote commands are strictly read-only. Credential
// failures are detected here and answered with a fix: interactive terminals
// open the login flow and retry automatically; everywhere else the error
// carries the exact command and link.

/** Everything a failed command left behind (stderr + stdout + message). */
function failureOutput(error) {
  return [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n');
}

/** Runs the command; on a credential failure, recovers once and retries. */
function runCommand(command, stdio) {
  const run = () => execSync(command, { encoding: 'utf-8', stdio });

  try {
    return run();
  } catch (error) {
    const output = failureOutput(error);
    if (!auth.looksLikeAuthFailure(output)) throw error;

    if (auth.isInteractive() && auth.launchCloudflareLogin()) {
      try {
        return run(); // retry once, right after the login
      } catch (retryError) {
        const retryOutput = failureOutput(retryError);
        if (!auth.looksLikeAuthFailure(retryOutput)) throw retryError;
        throw auth.cloudflareAuthError(retryOutput);
      }
    }
    throw auth.cloudflareAuthError(output);
  }
}

/** Runs `wrangler d1 execute ... --json` and returns the resulting rows. */
function d1Query(dbName, sql, { remote = false } = {}) {
  const scope = remote ? '--remote' : '--local';
  const output = runCommand(
    `npx wrangler d1 execute ${dbName} ${scope} --json --command "${sql}"`,
    ['ignore', 'pipe', 'pipe'],
  );
  const parsed = JSON.parse(output);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return (block && block.results) || [];
}

/** Exports remote D1 tables to a SQL file (read-only). */
function d1ExportRemote(dbName, tables, outputFile) {
  const tableArgs = tables.map((table) => '--table=' + table).join(' ');
  runCommand(
    `npx wrangler d1 export ${dbName} --remote ${tableArgs} --output=${outputFile}`,
    ['ignore', 'inherit', 'pipe'],
  );
}

/** Imports a SQL file into the local D1. */
function d1ImportLocal(dbName, file) {
  execSync(`npx wrangler d1 execute ${dbName} --local --file=${file}`, { stdio: 'inherit' });
}

/**
 * Command prefix for local wrangler calls. Prefers the project's installed
 * Wrangler binary over `npx`, which adds ~2s of resolution to every single
 * invocation; falls back to npx when Wrangler is not installed locally.
 * Resolved from process.cwd() on purpose (this package runs from the npx cache).
 */
function localWranglerCommand() {
  const bin = path.join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return fs.existsSync(bin) ? `node "${bin}"` : 'npx wrangler';
}

/** Runs a command asynchronously, rejecting with whatever it printed on stderr. */
function runCommandAsync(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `wrangler exited with code ${code}`));
    });
  });
}

/**
 * Writes an object into the local R2 bucket (emulator). Asynchronous so several
 * puts can be in flight at once — each one is its own wrangler process — with
 * one retry for transient emulator/SQLite contention.
 */
async function r2PutObject(bucket, key, file, contentType, retries = 1) {
  const command = `${localWranglerCommand()} r2 object put "${bucket}/${key}" --file "${file}" --local --content-type "${contentType}"`;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await runCommandAsync(command);
      return;
    } catch (error) {
      if (attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

module.exports = { d1Query, d1ExportRemote, d1ImportLocal, r2PutObject };
