'use strict';

// Schema plan for push: compares the desired seed (generated from the local
// database or passed via --seed) with the remote instance state and returns
// the steps to align them. Ported from mini-commerce's
// `scripts/sync-schema-remote.mjs`, WITHOUT the content and terms parts:
// push never sends data.

const items = (data) => (Array.isArray(data) ? data : data?.items ?? data?.terms ?? data?.collections ?? data?.taxonomies ?? []);

/** Compares lists regardless of order. */
const sameSet = (a = [], b = []) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

const fieldPayload = (def) => ({
  slug: def.slug,
  label: def.label,
  type: def.type,
  ...(def.required !== undefined ? { required: def.required } : {}),
  ...(def.searchable !== undefined ? { searchable: def.searchable } : {}),
  ...(def.unique !== undefined ? { unique: def.unique } : {}),
  ...(def.indexed !== undefined ? { indexed: def.indexed } : {}),
  ...(def.translatable !== undefined ? { translatable: def.translatable } : {}),
  ...(def.defaultValue !== undefined ? { defaultValue: def.defaultValue } : {}),
  ...(def.widget ? { widget: def.widget } : {}),
  ...(def.options ? { options: def.options } : {}),
  ...(def.validation ? { validation: def.validation } : {}),
});

/** Compares JSON with sorted keys, to compare field definitions. */
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

const sameShape = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The server completes validation with defaults (minItems, retiredTypes...).
 * We only compare the keys the seed declares.
 */
const subsetMatches = (declared, actual) => {
  if (!declared) return true;
  if (!actual) return false;
  return Object.entries(declared).every(([key, value]) => key === 'retiredTypes' || sameShape(value, actual[key]));
};

/** Comparable shape of a block type field. */
const blockFieldShape = (field) => ({
  slug: field.slug,
  label: field.label,
  type: field.type,
  required: Boolean(field.required),
  validation: field.validation ?? null,
});

/**
 * Plans the steps to make the remote instance match the seed.
 *
 * @param {object} seed Desired seed — only `collections`, `blockTypes` and
 *   `taxonomies` are used; content, terms, menus and settings are ignored.
 * @param {{ request: (method: string, endpoint: string, body?: object) => Promise<any> }} api
 * @returns {Promise<Array<{ label: string, run: () => Promise<any> }>>}
 */
async function buildPlan(seed, api) {
  const plan = [];

  /** Plans creating or updating a field, comparing with what already exists. */
  function planField(collectionSlug, field, currentFields) {
    const existing = currentFields.get(field.slug);
    if (!existing) {
      plan.push({
        label: `create field ${collectionSlug}.${field.slug} (${field.type})`,
        run: () => api.request('POST', `/_emdash/api/schema/collections/${collectionSlug}/fields`, fieldPayload(field)),
      });
      return;
    }

    const changes = [
      existing.label !== field.label ? 'label' : null,
      existing.type !== field.type ? 'type' : null,
      Boolean(existing.required) !== Boolean(field.required) ? 'required' : null,
      Boolean(existing.searchable) !== Boolean(field.searchable) ? 'searchable' : null,
      field.defaultValue !== undefined && !sameShape(field.defaultValue, existing.defaultValue) ? 'defaultValue' : null,
      !subsetMatches(field.validation, existing.validation) ? 'validation' : null,
    ].filter(Boolean);

    if (changes.length) {
      plan.push({
        label: `update field ${collectionSlug}.${field.slug} (${changes.join(', ')})`,
        run: () =>
          api.request('PUT', `/_emdash/api/schema/collections/${collectionSlug}/fields/${field.slug}`, fieldPayload(field)),
      });
    }
  }

  /** Blocks-type fields, planned after the block types. */
  const deferredBlockFields = [];

  const existingCollections = new Map(
    items(await api.request('GET', '/_emdash/api/schema/collections')).map((c) => [c.slug, c]),
  );

  for (const def of seed.collections ?? []) {
    const current = existingCollections.get(def.slug);
    const collectionBody = {
      label: def.label,
      labelSingular: def.labelSingular ?? def.label,
      ...(def.description ? { description: def.description } : {}),
      ...(def.supports ? { supports: def.supports } : {}),
      ...(def.urlPattern ? { urlPattern: def.urlPattern } : {}),
      ...(def.routable !== undefined ? { routable: def.routable } : {}),
      ...(def.hidden !== undefined ? { hidden: def.hidden } : {}),
      ...(def.sortOrder !== undefined ? { sortOrder: def.sortOrder } : {}),
      ...(def.group !== undefined ? { group: def.group } : {}),
    };
    // `titleField`/`dateField` only exist on update and require a field that
    // already exists — that is why their PUT is planned after field creation.
    const collectionMeta = {
      ...(def.titleField !== undefined ? { titleField: def.titleField } : {}),
      ...(def.dateField !== undefined ? { dateField: def.dateField } : {}),
    };
    const metaChanges = current
      ? [
          def.titleField !== undefined && (current.titleField ?? null) !== (def.titleField ?? null) ? 'titleField' : null,
          def.dateField !== undefined && (current.dateField ?? null) !== (def.dateField ?? null) ? 'dateField' : null,
        ].filter(Boolean)
      : [];

    if (!current) {
      plan.push({
        label: `create collection ${def.slug}`,
        run: () => api.request('POST', '/_emdash/api/schema/collections', { slug: def.slug, ...collectionBody }),
      });
    } else {
      const changes = [
        current.label !== collectionBody.label ? 'label' : null,
        current.labelSingular !== collectionBody.labelSingular ? 'labelSingular' : null,
        collectionBody.urlPattern && current.urlPattern !== collectionBody.urlPattern ? 'urlPattern' : null,
        collectionBody.supports && !sameSet(current.supports, collectionBody.supports) ? 'supports' : null,
        def.routable !== undefined && Boolean(current.routable) !== Boolean(def.routable) ? 'routable' : null,
      ].filter(Boolean);
      if (changes.length) {
        plan.push({
          label: `update collection ${def.slug} (${changes.join(', ')})`,
          run: () => api.request('PUT', `/_emdash/api/schema/collections/${def.slug}`, collectionBody),
        });
      }
    }

    const currentFields = new Map(
      (current ? items(await api.request('GET', `/_emdash/api/schema/collections/${def.slug}/fields`)) : []).map((f) => [f.slug, f]),
    );

    for (const field of def.fields ?? []) {
      // Blocks fields reference types in allowedTypes, so they can only be
      // created after the block types.
      if (field.type === 'blocks') {
        deferredBlockFields.push({ collectionSlug: def.slug, field, currentFields });
        continue;
      }
      planField(def.slug, field, currentFields);
    }

    const metaLabel = (!current ? Object.keys(collectionMeta) : metaChanges).join(', ');
    if (metaLabel) {
      plan.push({
        label: `set admin columns ${def.slug} (${metaLabel})`,
        run: () =>
          api.request('PUT', `/_emdash/api/schema/collections/${def.slug}`, {
            ...collectionBody,
            ...collectionMeta,
          }),
      });
    }
  }

  const existingBlockTypes = new Map(
    items(await api.request('GET', '/_emdash/api/schema/block-types')).map((b) => [b.slug, b]),
  );

  for (const def of seed.blockTypes ?? []) {
    const currentVersion = def.currentVersion ?? 1;
    const version = (def.versions ?? []).find((v) => v.version === currentVersion) ?? (def.versions ?? [])[0];
    const fields = (version?.fields ?? []).map((field) => ({
      slug: field.slug,
      label: field.label,
      type: field.type,
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      ...(field.validation ? { validation: field.validation } : {}),
    }));

    const existing = existingBlockTypes.get(def.slug);
    if (!existing) {
      plan.push({
        label: `create block type ${def.slug}`,
        run: () =>
          api.request('POST', '/_emdash/api/schema/block-types', {
            slug: def.slug,
            label: def.label,
            ...(def.description ? { description: def.description } : {}),
            ...(def.icon ? { icon: def.icon } : {}),
            ...(def.category ? { category: def.category } : {}),
            fields,
          }),
      });
      continue;
    }

    // The fields live inside the block type's active version.
    const existingVersion =
      (existing.versions ?? []).find((v) => v.active) ??
      (existing.versions ?? []).find((v) => v.version === existing.currentVersion) ??
      (existing.versions ?? [])[0];

    // Changing the fields of a block type is a breaking change: it creates a
    // new inactive version and requires swapping the renderers before
    // activating. That is a conscious decision, so here we only warn.
    if (!sameShape((existingVersion?.fields ?? []).map(blockFieldShape), fields.map(blockFieldShape))) {
      throw new Error(
        `Block type ${def.slug} already exists with different fields. Create a new version in the admin (or via API with breaking=true) and activate it after deploying the renderers.`,
      );
    }

    if (existing.label !== def.label || (existing.description ?? null) !== (def.description ?? null)) {
      plan.push({
        label: `update block type ${def.slug} (metadata)`,
        run: () =>
          api.request('PUT', `/_emdash/api/schema/block-types/${def.slug}`, {
            expectedFingerprint: existingVersion?.fingerprint ?? existing.fingerprint ?? existing.fingerprintHash,
            label: def.label,
            ...(def.description ? { description: def.description } : {}),
          }),
      });
    }
  }

  // Now that the block types exist, blocks fields can be planned.
  for (const { collectionSlug, field, currentFields } of deferredBlockFields) {
    planField(collectionSlug, field, currentFields);
  }

  const existingTaxonomies = new Map(
    items(await api.request('GET', '/_emdash/api/taxonomies')).map((t) => [t.name, t]),
  );

  for (const def of seed.taxonomies ?? []) {
    const current = existingTaxonomies.get(def.name);
    const taxonomyBody = {
      label: def.label,
      labelSingular: def.labelSingular ?? def.label,
      hierarchical: def.hierarchical ?? false,
      collections: def.collections ?? [],
    };

    if (!current) {
      plan.push({
        label: `create taxonomy ${def.name}`,
        run: () => api.request('POST', '/_emdash/api/taxonomies', { name: def.name, ...taxonomyBody }),
      });
    } else {
      const changes = [
        current.label !== taxonomyBody.label ? 'label' : null,
        current.labelSingular !== taxonomyBody.labelSingular ? 'labelSingular' : null,
        Boolean(current.hierarchical) !== Boolean(taxonomyBody.hierarchical) ? 'hierarchical' : null,
        !sameSet(current.collections, taxonomyBody.collections) ? 'collections' : null,
      ].filter(Boolean);
      if (changes.length) {
        plan.push({
          label: `update taxonomy ${def.name} (${changes.join(', ')})`,
          run: () => api.request('PUT', `/_emdash/api/taxonomies/${def.name}`, taxonomyBody),
        });
      }
    }
  }

  return plan;
}

module.exports = { buildPlan };
