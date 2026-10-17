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
// Dry-run by default: without `apply` it only reads production (read-only
// queries) and prints the plan; `--apply` performs the full sync.

/** Prints the dry-run plan (no side effects). */
function printPlan({ dbName, r2Bucket, tableList, prodUrl, noBackup }) {
  ui.log(`\n📋 Plan — pull (production → local): [Database: ${dbName} · Bucket: ${r2Bucket}]`);
  ui.log(`   1. Stop the local dev server on port ${config.DEV_SERVER_PORT} (if running)`);
  ui.log(
    noBackup
      ? '   2. Back up local state — skipped (--no-backup)'
      : `   2. Back up local state (.wrangler/state/v3/{d1,r2} → .wrangler/backups, keeping the last ${config.BACKUP_KEEP})`,
  );
  ui.log('   3. Wipe local D1 + R2 state');
  ui.log(`   4. Export ${tableList.length} table(s) from the production D1 (read-only)`);
  ui.log('   5. Import the dump into the local emulator');
  ui.log(`   6. Download media from ${prodUrl} into the local R2`);
}

/**
 * Flow (--apply): kill dev server → backup → wipe → remote export (read-only)
 * → reorder dump → local import → sync media → report.
 *
 * @param {{ apply?: boolean, noBackup?: boolean }} options
 */
async function run({ apply = false, noBackup = false } = {}) {
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
    // 1. Read-only reconnaissance (safe in dry-run as well): production tables
    //    and the public project URL. Failures here abort before anything local
    //    is touched.
    const tableList = tables.resolveTables(dbName);

    const urlRows = wrangler.d1Query(
      dbName,
      "SELECT value FROM options WHERE name = 'emdash:site_url'",
      { remote: true },
    );
    if (urlRows.length === 0) {
      throw new Error(
        'Could not determine the project URL (emdash:site_url missing from the options table). Check that the remote database has the URL configured.',
      );
    }
    const prodUrl = JSON.parse(urlRows[0].value);
    ui.log(`🌐 Project URL (from production): ${prodUrl}`);

    if (!apply) {
      printPlan({ dbName, r2Bucket, tableList, prodUrl, noBackup });
      ui.log('\n🔎 Dry-run: nothing was changed. Run with --apply to execute.');
      return;
    }

    state.killDevServer(config.DEV_SERVER_PORT);

    // 2. Safety backup of the local state before any destruction.
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

    // 3. Exports every production table (read-only on the remote side).
    ui.log(`🚀 Exporting production D1 tables [Database: ${dbName}]...`);
    wrangler.d1ExportRemote(dbName, tableList, paths.dumpFile);

    ui.log('🏗️  Reordering dump schema to resolve Foreign Key dependencies...');
    fs.writeFileSync(paths.dumpFile, sql.reorderDump(fs.readFileSync(paths.dumpFile, 'utf-8')), 'utf-8');

    ui.log('\n📥 Importing the database into the local environment...');
    wrangler.d1ImportLocal(dbName, paths.dumpFile);

    ui.log('✅ Database synchronized successfully!');
    ui.log('🖼️  Syncing production media into the local R2...');

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
