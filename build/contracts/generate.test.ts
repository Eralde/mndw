import {mkdtempSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import assert from 'node:assert/strict';

import * as generator from './generate.js';
import {generateContracts} from './generate.js';
import {createProtocolDocuments} from './generate-shared-deps.js';

type JsonSchema = Record<string, unknown>;
type GoType = (schema: JsonSchema, path: string) => string;

const getGoType = (): GoType => {
  const goType = (generator as unknown as Record<string, unknown>).goType;

  assert.equal(typeof goType, 'function', 'goType must be exported for focused tests');

  return goType as GoType;
};

const repoRoot = resolve(import.meta.dirname, '../..');

const generatedDirectories = [
  'frontend/sdk/fixtures/manifests',
  'daemon/mndwd/internal/manifest/fixtures/manifests',
  'daemon/contracts-go/fixtures/manifests',
  'tooling/cli/fixtures/i18n-packages',
  'daemon/mndwd/internal/mgmt/fixtures/i18n-packages',
  'frontend/sdk/fixtures/palettes',
  'daemon/mndwd/internal/palette/fixtures/palettes',
  'daemon/contracts-go/fixtures/protocol',
  'frontend/sdk/fixtures/mws-members',
  'packages/go-mws-members/fixtures',
  'frontend/host/src/services/fixtures/rci-session/capability',
  'daemon/mndwd/internal/rcisession/testdata/capability',
  'frontend/sdk/fixtures/events',
  'daemon/contracts-go/fixtures/events',
  'daemon/mndwd/internal/events/fixtures',
  'daemon/mndwd/internal/mgmt/fixtures/mgmt',
  'frontend/host/src/runtime/fixtures/mgmt',
] as const;

const listFiles = (root: string, current = ''): string[] => {
  const files: string[] = [];

  for (const entry of readdirSync(join(root, current)).sort()) {
    const relativePath = join(current, entry);
    const absolutePath = join(root, relativePath);

    if (statSync(absolutePath).isDirectory()) {
      files.push(...listFiles(root, relativePath));
    } else {
      files.push(relativePath);
    }
  }

  return files;
};

const generatedPaths = [
  'contracts/manifest/manifest.schema.json',
  'contracts/protocol/shared-deps.json',
  ...Object.keys(createProtocolDocuments()).map((file) => join('contracts/protocol', file)),
  'contracts/tokens.json',
  'frontend/sdk/manifest.schema.json',
  'contracts/mws-member/mws-member.schema.json',
  'contracts/rci-session/status-categories.json',
  'frontend/host/src/services/rci-session-status-categories.ts',
  'frontend/sdk/src/tokens.ts',
  'frontend/sdk/src/tokens.css',
  'daemon/mndwd/internal/palette/theme_tokens_generated.go',
  'contracts/events/events.schema.json',
  'daemon/contracts-go/events/events.go',
  'daemon/contracts-go/manifest/permissions_generated.go',
  ...generatedDirectories.flatMap((directory) =>
    listFiles(join(repoRoot, directory)).map((file) => join(directory, file))
  ),
];

const testUnsupportedGoSchemas = (): void => {
  const goType = getGoType();
  const unsupportedSchemas: readonly JsonSchema[] = [
    {anyOf: [{type: 'string'}]},
    {enum: ['one', 'two']},
    {type: ['string', 'null']},
  ];

  for (const schema of unsupportedSchemas) {
    assert.throws(
      () => goType(schema, 'payload field test.value'),
      /unsupported JSON schema construct at payload field test\.value/,
    );
  }
};

const run = (): void => {
  testUnsupportedGoSchemas();

  const outputRoot = mkdtempSync(join(tmpdir(), 'mndw-contracts-'));

  generateContracts({repoRoot, outputRoot});

  for (const relativePath of generatedPaths) {
    const expected = readFileSync(join(repoRoot, relativePath));
    const actual = readFileSync(join(outputRoot, relativePath));

    assert.deepEqual(actual, expected, relativePath);
  }
};

run();
