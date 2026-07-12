import path from 'node:path';
import fs from 'node:fs';
import {z} from 'zod';
import {pluginManifestSchema} from '../src/manifest-schema.js';

// Emits a JSON Schema derived from the Zod manifest schema so editors can validate and autocomplete
// plugin `manifest.json` files (via a `$schema` reference). Runtime validation still happens in Zod
// (`manifest-validator.ts`) and, on the daemon, in the mirrored Go validator.
const schemaOutPath = path.resolve(import.meta.dirname, '..', 'manifest.schema.json');

// `unrepresentable: 'any'` drops the `.refine()`/`.superRefine()`/`.transform()` constraints that
// have no JSON Schema equivalent instead of throwing.
const jsonSchema = z.toJSONSchema(pluginManifestSchema, {unrepresentable: 'any'});

const document = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://mndw/plugin-manifest.schema.json',
  title: 'mndw plugin manifest',
  description:
    'Manifest for an mndw plugin (widget or page). Generated from the Zod schema — do not edit by hand; run `pnpm generate-manifest-schema`.',
  ...jsonSchema,
};

fs.writeFileSync(schemaOutPath, JSON.stringify(document, null, 2) + '\n');
console.log(`Generated ${schemaOutPath}`);
