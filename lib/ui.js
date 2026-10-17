'use strict';

// CLI output centralized here (English, with emojis) to keep the format
// consistent across every command.

/** Progress line (stdout). */
const log = (message) => console.log(message);

/** Non-fatal warning (stderr). */
const warn = (message) => console.warn(message);

/** Error (stderr). */
const fail = (message) => console.error(message);

module.exports = { log, warn, fail };
