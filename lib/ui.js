'use strict';

// Saída do CLI centralizada neste módulo (PT-BR, com emojis) para manter o
// formato consistente entre todos os comandos.

/** Linha de progresso (stdout). */
const log = (message) => console.log(message);

/** Aviso não fatal (stderr). */
const warn = (message) => console.warn(message);

/** Erro (stderr). */
const fail = (message) => console.error(message);

module.exports = { log, warn, fail };
