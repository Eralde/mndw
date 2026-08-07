import {mkdtempSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import assert from 'node:assert/strict';

import {generateContracts} from './generate.js';
import {createProtocolDocuments} from './generate-shared-deps.js';

const repoRoot = resolve(import.meta.dirname, '../..');

const generatedDirectories = [
  'frontend/sdk/fixtures/manifests',
  'daemon/mndwd/internal/manifest/fixtures/manifests',
  'daemon/contracts-go/fixtures/manifests',
  'frontend/sdk/fixtures/palettes',
  'daemon/mndwd/internal/palette/fixtures/palettes',
  'daemon/contracts-go/fixtures/protocol',
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
  'frontend/sdk/src/tokens.ts',
  'frontend/sdk/src/tokens.css',
  'daemon/mndwd/internal/palette/theme_tokens_generated.go',
  ...generatedDirectories.flatMap((directory) =>
    listFiles(join(repoRoot, directory)).map((file) => join(directory, file))
  ),
];

const run = (): void => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'mndw-contracts-'));

  generateContracts({repoRoot, outputRoot});

  for (const relativePath of generatedPaths) {
    const expected = readFileSync(join(repoRoot, relativePath));
    const actual = readFileSync(join(outputRoot, relativePath));

    assert.deepEqual(actual, expected, relativePath);
  }
};

run();
