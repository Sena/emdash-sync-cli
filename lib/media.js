'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ui = require('./ui');
const { d1Query, r2PutObject } = require('./wrangler');

// Media mirrors production files into the local emulator. Both halves of the
// job (download from the public API, inject into local R2) are I/O bound on
// process/network latency, not CPU, so they run through a shared pool: each
// worker owns one file end to end. Every `wrangler r2 object put --local` is a
// fresh ~2s process, which is why the work is overlapped instead of serialized.
//
// The default stays deliberately low: the downloads hit the live public API, and
// production (Cloudflare/WAF) starts resetting connections above a handful of
// parallel requests, which surfaces as `fetch failed`. Raise it for a quiet
// origin, not for a fast one.
const DEFAULT_CONCURRENCY = 4;

/** Concurrency for the media pool (env override, clamped to a sane range). */
function resolveConcurrency() {
  const raw = Number(process.env.EMDASH_SYNC_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(raw), 32);
}

/**
 * Downloads a URL, retrying connection-level failures (resets, timeouts) and
 * 5xx with an exponential wait: 1s, then 3s. A 4xx is the server saying the
 * file is gone, so it comes back immediately for the caller to report as
 * skipped; a 5xx that survives the retries is a real failure.
 */
async function fetchWithRetry(url, retries = 2) {
  const waits = [1000, 3000];
  const pause = (attempt) =>
    new Promise((resolve) => setTimeout(resolve, waits[attempt] ?? waits[waits.length - 1]));

  for (let i = 0; i <= retries; i++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (i === retries) throw err;
      await pause(i);
      continue;
    }

    if (res.ok || res.status < 500) return res;
    if (i === retries) throw new Error(`HTTP ${res.status} from ${url}`);
    await pause(i);
  }
}

/** Describes a fetch failure with its real cause (ECONNRESET, DNS, timeout...). */
function describeError(error) {
  const cause = error?.cause?.code || error?.cause?.message;
  return cause ? `${error.message} (${cause})` : error.message;
}

/** Streams the response body to disk (keeps large videos out of memory). */
async function writeBody(response, tempPath) {
  if (!response.body) {
    fs.writeFileSync(tempPath, Buffer.from(await response.arrayBuffer()));
    return;
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));
}

/**
 * Runs `worker` over every item with at most `limit` in flight, keeping the
 * input order irrelevant: the pool pulls the next item as soon as a worker is
 * free, so a slow file never stalls the others.
 */
async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Mirrors production media into local R2: lists the `media` table, downloads
 * every file from the public API and injects it into the emulator, with
 * `resolveConcurrency()` files in flight at once. Prints the final report
 * (database × downloaded/skipped/failed).
 */
async function syncMedia({ dbName, r2Bucket, prodUrl }) {
  const mediaFiles = d1Query(dbName, 'SELECT id, mime_type, storage_key FROM media');
  const stats = { downloaded: 0, skipped: 0, failed: 0 };

  if (mediaFiles.length > 0) {
    const concurrency = resolveConcurrency();
    ui.log(
      `Found ${mediaFiles.length} media records in the database. Syncing to local R2, ${concurrency} file(s) at a time [Bucket: ${r2Bucket}]...`,
    );

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
          await writeBody(response, tempPath);

          await r2PutObject(r2Bucket, storageKey, tempPath, file.mime_type);
          stats.downloaded += 1;
          ui.log(`- ✅ Downloaded and saved: ${storageKey}`);
        } else {
          stats.skipped += 1;
          ui.warn(`- ⚠️ [Skipped] Failed to download ${storageKey} (Status: ${response.status}) - It may have been deleted in production.`);
        }
      } catch (fetchErr) {
        stats.failed += 1;
        ui.fail(`- ❌ Error processing ${storageKey}: ${describeError(fetchErr)}`);
      } finally {
        if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      }
    };

    try {
      await runPool(mediaFiles, concurrency, processFile);
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
