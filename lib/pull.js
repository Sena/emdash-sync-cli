'use strict';

const fs = require('fs');

const ui = require('./ui');
const config = require('./config');
const state = require('./state');
const tables = require('./tables');
const wrangler = require('./wrangler');
const sql = require('./sql');
const media = require('./media');

// The `pull` command: production (D1 + R2) → local emulator.

/**
 * Flow: kill dev server → backup → wipe → remote export (read-only) →
 * reorder dump → local import → sync media → report.
 *
 * @param {{ noBackup?: boolean }} options
 */
async function run({ noBackup = false } = {}) {
  let project;
  try {
    project = config.loadProject();
  } catch (err) {
    ui.fail(`❌ Configuration error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { dbName, r2Bucket, paths } = project;
  let exitCode = 0;

  try {
    state.killDevServer(config.DEV_SERVER_PORT);

    // 1. Safety backup of the local state before any destruction.
    if (noBackup) {
      ui.log('⏭️  Backup disabled (--no-backup).');
    } else {
      ui.log('💾 Backing up local state (.wrangler/state/v3/{d1,r2})...');
      try {
        const { dest, copied } = state.createBackup(paths);
        ui.log(`   Backup saved to ${dest} (${copied} folder(s), keeping the last ${config.BACKUP_KEEP}).`);
      } catch (err) {
        throw new Error(`Backup failed (${err.message}). Run with --no-backup to skip the backup.`);
      }
    }

    ui.log('🧹 Wiping old local database and storage...');
    state.wipeLocalState(paths);

    // 2. Discovers the remote database tables and exports all of them
    //    (except internal/FTS ones).
    const tableList = tables.resolveTables(dbName);

    ui.log(`🚀 Exporting production D1 tables [Database: ${dbName}]...`);
    wrangler.d1ExportRemote(dbName, tableList, paths.dumpFile);

    ui.log('🏗️  Reordering dump schema to resolve Foreign Key dependencies...');
    fs.writeFileSync(paths.dumpFile, sql.reorderDump(fs.readFileSync(paths.dumpFile, 'utf-8')), 'utf-8');

    ui.log('\n📥 Importing the database into the local environment...');
    wrangler.d1ImportLocal(dbName, paths.dumpFile);

    ui.log('✅ Database synchronized successfully!');
    ui.log('🖼️  Fetching site info and media list...');

    // Reads the production URL from the options table (the value is serialized).
    const urlRows = wrangler.d1Query(dbName, "SELECT value FROM options WHERE name = 'emdash:site_url'");
    if (urlRows.length === 0) {
      throw new Error('Could not determine the project URL (emdash:site_url missing from the options table). Check that the remote database has the URL configured.');
    }
    const prodUrl = JSON.parse(urlRows[0].value);
    ui.log(`🌐 Detected project URL: ${prodUrl}`);

    await media.syncMedia({ dbName, r2Bucket, prodUrl });

    ui.log('\n🎉 Sync 100% complete! Local environment is identical to production.');
  } catch (error) {
    ui.fail(`\n❌ Error during sync: ${error.message}`);
    exitCode = 1;
  } finally {
    // Safety sanitization: deletes the SQL dump produced by the export.
    if (fs.existsSync(paths.dumpFile)) {
      fs.rmSync(paths.dumpFile, { force: true });
      ui.log('\n🧹 [Sanitization] Temporary SQL dump deleted successfully.');
    }
    if (exitCode !== 0) process.exitCode = exitCode;
  }
}

module.exports = { run };
