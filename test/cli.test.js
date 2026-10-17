'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('../lib/cli');
const { runCli } = require('./helpers/run-cli');

test('parseArgs: parses the command and both flag styles', () => {
  const parsed = parseArgs(['push', '--apply', '--seed=x.json', '--url', 'http://localhost:4321']);
  assert.deepEqual(parsed.positionals, ['push']);
  assert.equal(parsed.flags.get('apply'), true);
  assert.equal(parsed.flags.get('seed'), 'x.json');
  assert.equal(parsed.flags.get('url'), 'http://localhost:4321');
});

test('parseArgs: -h maps to help', () => {
  assert.equal(parseArgs(['-h']).flags.get('help'), true);
});

test('parseArgs: unknown flags and missing values produce errors', () => {
  assert.match(parseArgs(['--nope']).error, /Unknown flag/);
  assert.match(parseArgs(['--seed']).error, /Missing value/);
});

test('bare invocation prints the help and exits 0', async () => {
  const result = await runCli([]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /emdash-sync pull/);
  assert.match(result.stdout, /emdash-sync push/);
});

test('flags without a command are rejected', async () => {
  const result = await runCli(['--apply']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing command/);
});

test('unknown commands are rejected', async () => {
  const result = await runCli(['sync']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command/);
});

test('help prints the usage and exits 0', async () => {
  const result = await runCli(['help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
});

test('pull rejects the push-only flags', async () => {
  const result = await runCli(['pull', '--seed=seed.json']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /only available for "push"/);
});

test('push rejects --no-backup', async () => {
  const result = await runCli(['push', '--no-backup']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /only available for "pull"/);
});

test('a second positional argument is rejected', async () => {
  const result = await runCli(['pull', 'extra']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unexpected argument/);
});
