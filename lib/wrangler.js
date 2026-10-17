'use strict';

const { execSync } = require('child_process');

// Thin wrappers around the Wrangler CLI. Single choke point for every
// `wrangler` invocation — remote commands are strictly read-only.

/** Runs `wrangler d1 execute ... --json` and returns the resulting rows. */
function d1Query(dbName, sql, { remote = false } = {}) {
  const scope = remote ? '--remote' : '--local';
  const output = execSync(
    `npx wrangler d1 execute ${dbName} ${scope} --json --command "${sql}"`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const parsed = JSON.parse(output);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return (block && block.results) || [];
}

/** Exports remote D1 tables to a SQL file (read-only). */
function d1ExportRemote(dbName, tables, outputFile) {
  const tableArgs = tables.map((table) => '--table=' + table).join(' ');
  execSync(`npx wrangler d1 export ${dbName} --remote ${tableArgs} --output=${outputFile}`, { stdio: 'inherit' });
}

/** Imports a SQL file into the local D1. */
function d1ImportLocal(dbName, file) {
  execSync(`npx wrangler d1 execute ${dbName} --local --file=${file}`, { stdio: 'inherit' });
}

/** Writes an object into the local R2 bucket (emulator). */
function r2PutObject(bucket, key, file, contentType) {
  execSync(`npx wrangler r2 object put ${bucket}/${key} --file "${file}" --local --content-type "${contentType}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
}

module.exports = { d1Query, d1ExportRemote, d1ImportLocal, r2PutObject };
