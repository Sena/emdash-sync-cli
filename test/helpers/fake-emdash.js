'use strict';

const http = require('http');

// In-memory fake of the EmDash admin API for hermetic tests: an ephemeral
// HTTP server on 127.0.0.1 with no wrangler, no Cloudflare and no
// credentials. Only the endpoints the sync CLI touches are implemented;
// everything else answers 404 like the real API. Every request is recorded
// so tests can assert what was — and was not — written.

const DEV_BYPASS = '/_emdash/api/auth/dev-bypass';

/** The collection list does not carry the fields map. */
function stripFields(collection) {
  const { fields, ...rest } = collection;
  return rest;
}

/**
 * @param {object} [options]
 * @param {string} [options.token] When set, Bearer tokens must match it (a
 *   dev-bypass session cookie is still accepted).
 * @param {Array} [options.collections] Initial collections (each may carry a `fields` array).
 * @param {Array} [options.blockTypes] Initial block types (a `fields` array is wrapped into version 1).
 * @param {Array} [options.taxonomies] Initial taxonomies.
 */
async function startFakeEmdash(options = {}) {
  const state = {
    collections: new Map(),
    blockTypes: new Map(),
    taxonomies: new Map(),
  };

  for (const collection of options.collections ?? []) {
    const { fields = [], ...rest } = collection;
    state.collections.set(rest.slug, { ...rest, fields: new Map(fields.map((field) => [field.slug, field])) });
  }

  for (const blockType of options.blockTypes ?? []) {
    const { fields, ...rest } = blockType;
    const entry = rest.versions
      ? rest
      : {
          ...rest,
          versions: [{ version: 1, active: true, fields: fields ?? [], fingerprint: `fp-${rest.slug}-1` }],
        };
    state.blockTypes.set(entry.slug, entry);
  }

  for (const taxonomy of options.taxonomies ?? []) {
    state.taxonomies.set(taxonomy.name, { ...taxonomy });
  }

  const requests = [];

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });

  const sendJson = (res, status, payload, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };

  const isAuthed = (req) => {
    const viaCookie = String(req.headers.cookie ?? '').includes('emdash_session');
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
    if (options.token) return viaCookie || bearer === options.token;
    return viaCookie || Boolean(req.headers.authorization);
  };

  async function handler(req, res) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined;
    requests.push({ method: req.method, path: pathname, body });

    // The real endpoint accepts a plain GET (that is how the CLI calls it).
    if (pathname === DEV_BYPASS && (req.method === 'GET' || req.method === 'POST')) {
      sendJson(res, 200, { success: true }, { 'Set-Cookie': 'emdash_session=fake; Path=/; HttpOnly' });
      return;
    }

    if (!isAuthed(req)) {
      sendJson(res, 401, { success: false, error: 'unauthorized' });
      return;
    }

    const parts = pathname.split('/').filter(Boolean);

    // /_emdash/api/schema/collections[...]
    if (parts[3] === 'collections') {
      if (parts.length === 4) {
        if (req.method === 'GET') {
          sendJson(res, 200, { success: true, data: [...state.collections.values()].map(stripFields) });
          return;
        }
        if (req.method === 'POST') {
          if (!body?.slug || state.collections.has(body.slug)) {
            sendJson(res, 409, { success: false, error: 'collection exists' });
            return;
          }
          const { slug, ...rest } = body;
          const created = { slug, ...rest, fields: new Map() };
          state.collections.set(slug, created);
          sendJson(res, 200, { success: true, data: stripFields(created) });
          return;
        }
      }

      const collection = state.collections.get(parts[4]);
      if (parts.length === 5 && collection && req.method === 'PUT') {
        Object.assign(collection, body);
        sendJson(res, 200, { success: true, data: stripFields(collection) });
        return;
      }

      if (parts.length === 6 && parts[5] === 'fields' && collection) {
        if (req.method === 'GET') {
          sendJson(res, 200, { success: true, data: [...collection.fields.values()] });
          return;
        }
        if (req.method === 'POST') {
          if (body?.slug) collection.fields.set(body.slug, { ...body });
          sendJson(res, 200, { success: true, data: { ...body } });
          return;
        }
      }

      if (parts.length === 7 && parts[5] === 'fields' && collection) {
        const field = collection.fields.get(parts[6]);
        if (field && req.method === 'PUT') {
          Object.assign(field, body);
          sendJson(res, 200, { success: true, data: { ...field } });
          return;
        }
      }
    }

    // /_emdash/api/schema/block-types[...]
    if (parts[3] === 'block-types') {
      if (parts.length === 4) {
        if (req.method === 'GET') {
          sendJson(res, 200, { success: true, data: [...state.blockTypes.values()] });
          return;
        }
        if (req.method === 'POST') {
          if (!body?.slug || state.blockTypes.has(body.slug)) {
            sendJson(res, 409, { success: false, error: 'block type exists' });
            return;
          }
          const { slug, ...rest } = body;
          const created = {
            slug,
            ...rest,
            versions: [{ version: 1, active: true, fields: body.fields ?? [], fingerprint: `fp-${slug}-1` }],
          };
          state.blockTypes.set(slug, created);
          sendJson(res, 200, { success: true, data: { ...created } });
          return;
        }
      }

      const blockType = state.blockTypes.get(parts[4]);
      if (parts.length === 5 && blockType && req.method === 'PUT') {
        if (body.label !== undefined) blockType.label = body.label;
        if (body.description !== undefined) blockType.description = body.description;
        sendJson(res, 200, { success: true, data: { ...blockType } });
        return;
      }
    }

    // /_emdash/api/taxonomies[...]  (note: no `schema` segment)
    if (parts[2] === 'taxonomies') {
      if (parts.length === 3) {
        if (req.method === 'GET') {
          sendJson(res, 200, { success: true, data: [...state.taxonomies.values()] });
          return;
        }
        if (req.method === 'POST') {
          if (!body?.name || state.taxonomies.has(body.name)) {
            sendJson(res, 409, { success: false, error: 'taxonomy exists' });
            return;
          }
          state.taxonomies.set(body.name, { ...body });
          sendJson(res, 200, { success: true, data: { ...body } });
          return;
        }
      }

      const taxonomy = state.taxonomies.get(parts[3]);
      if (parts.length === 4 && taxonomy && req.method === 'PUT') {
        Object.assign(taxonomy, body);
        sendJson(res, 200, { success: true, data: { ...taxonomy } });
        return;
      }
    }

    sendJson(res, 404, { success: false, error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      sendJson(res, 500, { success: false, error: 'fake server error' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    /** Requests that change remote state (dev-bypass excluded). */
    writes: () => requests.filter((request) => request.method !== 'GET' && request.path !== DEV_BYPASS),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startFakeEmdash };
