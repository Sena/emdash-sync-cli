'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { BACKUP_KEEP } = require('./config');
const ui = require('./ui');

// Gerenciamento do estado local do emulador: dev server, backups e wipe.

/**
 * Tenta derrubar o dev server (Astro/Vite) que possa estar segurando os
 * arquivos locais do D1/R2. Falha silenciosamente se a porta estiver livre.
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
            ui.log(`🔫 Matando processo do dev server (PID: ${pid}) na porta ${port}...`);
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          }
        }
      }
    } else {
      const output = execSync(`lsof -t -i:${port}`).toString().trim();
      const pids = output.split('\n').filter(Boolean);
      for (const pid of pids) {
        ui.log(`🔫 Matando processo do dev server (PID: ${pid}) na porta ${port}...`);
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      }
    }
    // Aguarda um segundo para o SO liberar os locks dos arquivos
    execSync(process.platform === 'win32' ? 'timeout /t 1 /nobreak' : 'sleep 1', { stdio: 'ignore' });
  } catch (err) {
    // Falha silenciosa (porta livre)
  }
}

/** Remove os backups mais antigos, mantendo os BACKUP_KEEP últimos. */
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
    // Podar backup não é crítico.
  }
}

/** Copia d1 e r2 locais para .wrangler/backups/<timestamp>/ antes do wipe. */
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

/** Apaga o estado local (D1 + R2 do emulador) para receber o clone. */
function wipeLocalState(paths) {
  try {
    if (fs.existsSync(paths.d1Dir)) fs.rmSync(paths.d1Dir, { recursive: true, force: true });
    if (fs.existsSync(paths.r2Dir)) fs.rmSync(paths.r2Dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error('Não foi possível apagar os arquivos antigos. O servidor dev ainda pode estar rodando ou prendendo o arquivo.');
  }
}

module.exports = { killDevServer, createBackup, wipeLocalState };
