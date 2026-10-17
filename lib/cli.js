'use strict';

const ui = require('./ui');
const pull = require('./pull');

/** `true` quando o processo recebeu a flag `--<name>`. */
const hasFlag = (name) => process.argv.includes(`--${name}`);

/**
 * Entrada do CLI. O `pull` (produção → local) é o comando padrão; comandos
 * futuros (ex.: um `push` de schema) entram aqui no dispatch.
 */
async function main() {
  try {
    await pull.run({ noBackup: hasFlag('no-backup') });
  } catch (error) {
    // Rede de segurança: pull.run() já trata os próprios erros.
    ui.fail(`\n❌ Erro inesperado: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
