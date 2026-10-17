'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.EMDASH_SYNC_AUTO_LOGIN = '0';
delete process.env.EMDASH_TOKEN;
delete process.env.EMDASH_COOKIE;

const { buildPlan } = require('../lib/schema');
const { createClient } = require('../lib/api');
const { startFakeEmdash } = require('./helpers/fake-emdash');

// Full seed: a collection with plain + media fields and one deferred `blocks`
// field, the block type that field references, and a taxonomy.
const SEED = {
  collections: [
    {
      slug: 'products',
      label: 'Products',
      labelSingular: 'Product',
      supports: ['titles', 'media'],
      urlPattern: '/products/:slug',
      titleField: 'title',
      fields: [
        { slug: 'title', label: 'Title', type: 'text', required: true },
        { slug: 'price', label: 'Price', type: 'number', validation: { min: 0 } },
        { slug: 'gallery', label: 'Gallery', type: 'media' },
        { slug: 'hero_section', label: 'Hero section', type: 'blocks' },
      ],
    },
  ],
  blockTypes: [
    {
      slug: 'hero',
      label: 'Hero',
      description: 'Page header',
      currentVersion: 1,
      versions: [{ version: 1, fields: [{ slug: 'heading', label: 'Heading', type: 'text', required: true }] }],
    },
  ],
  taxonomies: [
    { name: 'category', label: 'Categories', labelSingular: 'Category', collections: ['products'] },
  ],
};

const labels = (plan) => plan.map((step) => step.label);

async function applyPlan(plan) {
  for (const step of plan) await step.run();
}

test('buildPlan: plans collections, fields, block types and taxonomies for an empty remote', async () => {
  const fake = await startFakeEmdash();
  try {
    const api = await createClient(fake.url);
    const plan = await buildPlan(SEED, api);

    assert.deepEqual(labels(plan), [
      'create collection products',
      'create field products.title (text)',
      'create field products.price (number)',
      'create field products.gallery (media)',
      'set admin columns products (titleField)',
      'create block type hero',
      'create field products.hero_section (blocks)',
      'create taxonomy category',
    ]);
  } finally {
    await fake.close();
  }
});

test('buildPlan: applying the plan once is idempotent', async () => {
  const fake = await startFakeEmdash();
  try {
    const api = await createClient(fake.url);
    await applyPlan(await buildPlan(SEED, api));
    assert.deepEqual(labels(await buildPlan(SEED, api)), []);
  } finally {
    await fake.close();
  }
});

test('buildPlan: server-side validation defaults do not produce update steps', async () => {
  const fake = await startFakeEmdash({
    collections: [
      {
        slug: 'products',
        label: 'Products',
        labelSingular: 'Product',
        supports: ['titles', 'media'],
        urlPattern: '/products/:slug',
        titleField: 'title',
        fields: [
          { slug: 'title', label: 'Title', type: 'text', required: true },
          // The server completed the validation with its own defaults.
          { slug: 'price', label: 'Price', type: 'number', validation: { min: 0, retiredTypes: [] } },
        ],
      },
    ],
  });
  try {
    const api = await createClient(fake.url);
    const seed = {
      collections: [
        {
          slug: 'products',
          label: 'Products',
          labelSingular: 'Product',
          supports: ['titles', 'media'],
          urlPattern: '/products/:slug',
          titleField: 'title',
          fields: [
            { slug: 'title', label: 'Title', type: 'text', required: true },
            { slug: 'price', label: 'Price', type: 'number', validation: { min: 0 } },
          ],
        },
      ],
    };

    assert.deepEqual(labels(await buildPlan(seed, api)), []);
  } finally {
    await fake.close();
  }
});

test('buildPlan: a validation difference produces a targeted update step', async () => {
  const fake = await startFakeEmdash({
    collections: [
      {
        slug: 'products',
        label: 'Products',
        labelSingular: 'Product',
        titleField: 'title',
        fields: [
          { slug: 'title', label: 'Title', type: 'text', required: true },
          { slug: 'price', label: 'Price', type: 'number', validation: { min: 0 } },
        ],
      },
    ],
  });
  try {
    const api = await createClient(fake.url);
    const seed = {
      collections: [
        {
          slug: 'products',
          label: 'Products',
          labelSingular: 'Product',
          titleField: 'title',
          fields: [
            { slug: 'title', label: 'Title', type: 'text', required: true },
            { slug: 'price', label: 'Price', type: 'number', validation: { min: 1 } },
          ],
        },
      ],
    };

    const plan = await buildPlan(seed, api);
    assert.deepEqual(labels(plan), ['update field products.price (validation)']);

    await applyPlan(plan);
    assert.deepEqual(labels(await buildPlan(seed, api)), []);
  } finally {
    await fake.close();
  }
});

test('buildPlan: a block type with different fields is refused as a breaking change', async () => {
  const fake = await startFakeEmdash({
    blockTypes: [{ slug: 'hero', label: 'Hero', fields: [{ slug: 'legacy', label: 'Legacy', type: 'text' }] }],
  });
  try {
    const api = await createClient(fake.url);
    const seed = {
      blockTypes: [
        {
          slug: 'hero',
          label: 'Hero',
          currentVersion: 1,
          versions: [{ version: 1, fields: [{ slug: 'heading', label: 'Heading', type: 'text' }] }],
        },
      ],
    };

    await assert.rejects(buildPlan(seed, api), /already exists with different fields/);
  } finally {
    await fake.close();
  }
});

test('buildPlan: block type metadata update carries the expected fingerprint', async () => {
  const fake = await startFakeEmdash({
    blockTypes: [
      { slug: 'hero', label: 'Old hero', fields: [{ slug: 'heading', label: 'Heading', type: 'text', required: true }] },
    ],
  });
  try {
    const api = await createClient(fake.url);
    const seed = {
      blockTypes: [
        {
          slug: 'hero',
          label: 'Hero',
          currentVersion: 1,
          versions: [{ version: 1, fields: [{ slug: 'heading', label: 'Heading', type: 'text', required: true }] }],
        },
      ],
    };

    const plan = await buildPlan(seed, api);
    assert.deepEqual(labels(plan), ['update block type hero (metadata)']);
    await applyPlan(plan);

    const put = fake
      .writes()
      .find((request) => request.method === 'PUT' && request.path.endsWith('/block-types/hero'));
    assert.equal(put.body.expectedFingerprint, 'fp-hero-1');
    assert.equal(put.body.label, 'Hero');

    assert.deepEqual(labels(await buildPlan(seed, api)), []);
  } finally {
    await fake.close();
  }
});

test('buildPlan: a taxonomy label change is an update step', async () => {
  const fake = await startFakeEmdash({
    taxonomies: [{ name: 'category', label: 'Old', labelSingular: 'Old', hierarchical: false, collections: ['products'] }],
  });
  try {
    const api = await createClient(fake.url);
    const seed = {
      taxonomies: [{ name: 'category', label: 'Categories', labelSingular: 'Category', collections: ['products'] }],
    };

    const plan = await buildPlan(seed, api);
    assert.deepEqual(labels(plan), ['update taxonomy category (label, labelSingular)']);

    await applyPlan(plan);
    assert.deepEqual(labels(await buildPlan(seed, api)), []);
  } finally {
    await fake.close();
  }
});
