#!/usr/bin/env node
'use strict';

// Ponto de entrada do CLI: fino por design; toda a lógica vive em lib/.
require('./lib/cli').main();
