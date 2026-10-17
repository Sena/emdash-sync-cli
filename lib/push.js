'use strict';

const ui = require('./ui');
const seedLib = require('./seed');
const schema = require('./schema');
const { createClient } = require('./api');
const { resolveSiteUrl } = require('./site-url');

// The `push` command: sends the LOCAL schema to a remote instance (production).
// Schema only — collections, fields, block types and taxonomies. Never content,
// terms, menus, widgets or settings. Without `--apply` (the default) it only
// prints the plan (dry-run) and writes nothing to the target.

/**
 * Flow: resolve the target → load the seed (local DB or --seed) → authenticate
 * → plan the steps against the API → dry-run or apply.
 *
 * @param {{ apply?: boolean, url?: string, seed?: string }} options
 */
async function run({ apply = false, url: urlOption, seed: seedOption } = {}) {
  let url = String(urlOption ?? process.env.EMDASH_URL ?? '').replace(/\/+$/, '');
  let urlSource = url ? (urlOption ? '--url' : 'EMDASH_URL') : '';

  if (!url) {
    // No explicit target: discover production (SITE_URL → Cloudflare → EmDash CLI).
    try {
      const resolved = await resolveSiteUrl();
      url = resolved.url;
      urlSource = resolved.source;
    } catch (error) {
      ui.fail(String(error?.message ?? error));
      ui.fail('\nPass --url=<url>, or set EMDASH_URL or SITE_URL.');
      process.exitCode = 1;
      return;
    }
  }

  let seed;
  let seedSource;
  try {
    ({ seed, source: seedSource } = seedLib.loadSeed(seedOption));
  } catch (error) {
    ui.fail(`❌ Could not build the schema to push: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  ui.log(`📄 Seed: ${seedSource}`);
  ui.log(`🎯 Target: ${url}${urlSource ? ` (via ${urlSource})` : ''}${apply ? '' : ' (dry-run)'}\n`);

  let exitCode = 0;
  try {
    const api = await createClient(url);
    const plan = await schema.buildPlan(seed, api);

    if (plan.length === 0) {
      ui.log('Nothing to do: the remote schema already matches the seed.');
      return;
    }

    for (const step of plan) ui.log(`${apply ? '→' : '·'} ${step.label}`);

    if (!apply) {
      ui.log(`\n${plan.length} step(s) planned. Run with --apply to execute.`);
      return;
    }

    ui.log('');
    let done = 0;
    for (const step of plan) {
      await step.run();
      done += 1;
      ui.log(`✔ ${step.label}`);
    }
    ui.log(`\n${done} step(s) applied.`);
  } catch (error) {
    ui.fail(`\n❌ Push failed: ${error.message}`);
    exitCode = 1;
  } finally {
    if (exitCode !== 0) process.exitCode = exitCode;
  }
}

module.exports = { run };
