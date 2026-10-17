'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { BACKUP_KEEP } = require('./config');
const ui = require('./ui');

// Local emulator state management: dev server, backups and wipe.

/**
 * Tries to kill the dev server (Astro/Vite) that may be holding the local
 * D1/R2 files open. Fails silently when the port is free.
 */
function killDevServer(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`).toString();
      const lines = output.trim().split('\n');
      for (const line of lines) {
        if (line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0') {
            ui.log(`🔫 Killing dev server process (PID: ${pid}) on port ${port}...`);
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          }
        }
      }
    } else {
      const output = execSync(`lsof -t -i:${port}`).toString().trim();
      const pids = output.split('\n').filter(Boolean);
      for (const pid of pids) {
        ui.log(`🔫 Killing dev server process (PID: ${pid}) on port ${port}...`);
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      }
    }
    // Wait a second for the OS to release file locks
    execSync(process.platform === 'win32' ? 'timeout /t 1 /nobreak' : 'sleep 1', { stdio: 'ignore' });
  } catch (err) {
    // Silent failure (port is free)
  }
}

/** Removes the oldest backups, keeping the BACKUP_KEEP most recent. */
function pruneBackups(root) {
  try {
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const excess = entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP));
    for (const name of excess) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch {
    // Pruning backups is not critical.
  }
}

/** Copies local d1 and r2 into .wrangler/backups/<timestamp>/ before the wipe. */
function createBackup(paths) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const dest = path.join(paths.backupsDir, stamp);
  fs.mkdirSync(dest, { recursive: true });

  let copied = 0;
  for (const source of [paths.d1Dir, paths.r2Dir]) {
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(dest, path.basename(source)), { recursive: true });
      copied += 1;
    }
  }
  pruneBackups(paths.backupsDir);
  return { dest, copied };
}

/** Deletes the local state (emulator D1 + R2) to receive the clone. */
function wipeLocalState(paths) {
  try {
    if (fs.existsSync(paths.d1Dir)) fs.rmSync(paths.d1Dir, { recursive: true, force: true });
    if (fs.existsSync(paths.r2Dir)) fs.rmSync(paths.r2Dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error('Could not delete the old files. The dev server may still be running or holding the file.');
  }
}

module.exports = { killDevServer, createBackup, wipeLocalState };
