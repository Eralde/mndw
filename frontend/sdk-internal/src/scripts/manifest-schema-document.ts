import {z} from 'zod';

import {pluginManifestSchema} from '../manifest-schema.js';

/** Builds editor-only JSON Schema from the Zod runtime authority. */
export function createManifestSchemaDocument(): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(pluginManifestSchema, {unrepresentable: 'any'});
  const variants = jsonSchema.oneOf as Array<{properties: Record<string, {const?: string}>}>;

  for (const {properties} of variants) {
    properties[properties.type.const === 'page' ? 'size' : 'route'] = {};
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://mndw/plugin-manifest.schema.json',
    title: 'mndw plugin manifest',
    description:
      'Manifest for an mndw plugin (widget or page). Generated from the Zod schema — do not edit by hand; run `pnpm generate-contracts`.',
    ...jsonSchema,
  };
}
