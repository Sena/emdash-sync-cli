'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ui = require('./ui');
const { d1Query, r2PutObject } = require('./wrangler');

/** Downloads a URL with 1 retry and a 1s wait between attempts. */
async function fetchWithRetry(url, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || i === retries) return res;
    } catch (err) {
      if (i === retries) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Mirrors production media into local R2: lists the `media` table, downloads
 * every file from the public API and injects it into the emulator in batches
 * of 10. Prints the final report (database × downloaded/skipped/failed).
 */
async function syncMedia({ dbName, r2Bucket, prodUrl }) {
  const mediaFiles = d1Query(dbName, 'SELECT id, mime_type, storage_key FROM media');
  const stats = { downloaded: 0, skipped: 0, failed: 0 };

  if (mediaFiles.length > 0) {
    ui.log(`Found ${mediaFiles.length} media records in the database. Syncing to local R2 in batches [Bucket: ${r2Bucket}]...`);

    const tmpSyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-'));

    const processFile = async (file) => {
      const storageKey = file.storage_key || file.id;

      if (!storageKey) {
        stats.skipped += 1;
        ui.warn('- ⚠️ [Skipped] Media record without storage_key.');
        return;
      }

      const url = `${prodUrl}/_emdash/api/media/file/${storageKey}`;
      const tempPath = path.join(tmpSyncDir, storageKey);

      try {
        const response = await fetchWithRetry(url, 1);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          // Synchronous write guarantees the write stream is closed before calling wrangler
          fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));

          r2PutObject(r2Bucket, storageKey, tempPath, file.mime_type);
          stats.downloaded += 1;
          ui.log(`- ✅ Downloaded and saved: ${storageKey}`);
        } else {
          stats.skipped += 1;
          ui.warn(`- ⚠️ [Skipped] Failed to download ${storageKey} (Status: ${response.status}) - It may have been deleted in production.`);
        }
      } catch (fetchErr) {
        stats.failed += 1;
        ui.fail(`- ❌ Error processing ${storageKey}: ${fetchErr.message}`);
      } finally {
        if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      }
    };

    try {
      // Processes media in batches of 10
      const batchSize = 10;
      for (let i = 0; i < mediaFiles.length; i += batchSize) {
        const batch = mediaFiles.slice(i, i + batchSize);
        await Promise.all(batch.map(processFile));
      }
    } finally {
      if (fs.existsSync(tmpSyncDir)) {
        fs.rmSync(tmpSyncDir, { recursive: true, force: true });
      }
    }
  }

  // Report: compares database media with what was written to local R2.
  const mediaCount = Number((d1Query(dbName, 'SELECT count(*) AS n FROM media')[0] || {}).n || 0);
  ui.log('\n📊 Media:');
  ui.log(`   In database: ${mediaCount} · downloaded: ${stats.downloaded} · skipped: ${stats.skipped} · failed: ${stats.failed}`);
  if (stats.downloaded < mediaCount) {
    ui.warn('   ⚠️  Local R2 may be incomplete. Run the sync again or check WAF/public URL.');
  } else {
    ui.log('   ✅ All media from the database are in local R2.');
  }

  return stats;
}

module.exports = { syncMedia };
