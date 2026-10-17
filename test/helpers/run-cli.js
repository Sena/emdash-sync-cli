'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Spawns the real CLI in a child process with a clean environment: no
// credentials from this machine, no auto-login, no URL settings that could
// steer resolution somewhere real. Hermetic by design.

const CLI = path.join(__dirname, '..', '..', 'index.js');

const CLEAN_ENV = {
  EMDASH_TOKEN: '',
  EMDASH_COOKIE: '',
  EMDASH_URL: '',
  SITE_URL: '',
  EMDASH_SYNC_AUTO_LOGIN: '0',
};

/**
 * @param {string[]} args CLI arguments.
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...CLEAN_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

module.exports = { runCli };
