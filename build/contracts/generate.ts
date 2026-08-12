import {copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createManifestSchemaDocument} from '../../frontend/sdk/scripts/manifest-schema-document.js';
import {PALETTE_CONTRAST_PAIRS, PALETTE_CSS_VARIABLES, buildPalette} from '../../tooling/palette-core/src/index.js';
import {renderCss, renderTs} from '../../build/palette/scripts/gen-tokens.js';
import {SCALE} from '../../build/palette/src/scale.js';
import {generateSharedDependencyContracts} from './generate-shared-deps.js';

export interface GenerateContractsOptions {
  readonly repoRoot: string;
  readonly outputRoot?: string;
}

interface FixtureMapping {
  readonly source: string;
  readonly destinations: readonly string[];
  readonly include?: (relativePath: string) => boolean;
}

const fixtureMappings: readonly FixtureMapping[] = [
  {
    source: 'contracts/manifest/fixtures',
    destinations: [
      'frontend/sdk/fixtures/manifests',
      'daemon/mndwd/internal/manifest/fixtures/manifests',
      'daemon/contracts-go/fixtures/manifests',
    ],
  },
  {
    source: 'contracts/palette/fixtures',
    destinations: ['frontend/sdk/fixtures/palettes', 'daemon/mndwd/internal/palette/fixtures/palettes'],
  },
  {
    source: 'contracts/i18n-packages',
    destinations: ['tooling/cli/fixtures/i18n-packages', 'daemon/mndwd/internal/mgmt/fixtures/i18n-packages'],
  },
  {
    source: 'contracts/protocol',
    destinations: ['daemon/contracts-go/fixtures/protocol'],
    include: (relativePath) => relativePath.endsWith('.golden.json'),
  },
];

const manifestSchemaPaths = [
  'contracts/manifest/manifest.schema.json',
  'frontend/sdk/manifest.schema.json',
] as const;

const tokenContractPath = 'contracts/tokens.json';
const generatedGoThemeTokensPath = 'daemon/mndwd/internal/palette/theme_tokens_generated.go';

function listFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root).sort()) {
    const absolutePath = join(root, entry);

    if (statSync(absolutePath).isDirectory()) {
      for (const file of listFiles(absolutePath)) {
        files.push(join(entry, file));
      }
    } else {
      files.push(entry);
    }
  }

  return files;
}

function copyDirectory(
  sourceRoot: string,
  destinationRoot: string,
  include: (relativePath: string) => boolean = () => true,
): void {
  const files = listFiles(sourceRoot).filter(include);

  if (files.length === 0) {
    throw new Error(`Contract source directory is empty: ${sourceRoot}`);
  }

  rmSync(destinationRoot, {force: true, recursive: true});

  for (const relativePath of files) {
    const sourcePath = join(sourceRoot, relativePath);
    const destinationPath = join(destinationRoot, relativePath);

    mkdirSync(dirname(destinationPath), {recursive: true});
    copyFileSync(sourcePath, destinationPath);
  }
}

export function generateManifestSchema(options: GenerateContractsOptions): void {
  const outputRoot = resolve(options.outputRoot ?? options.repoRoot);
  const document = createManifestSchemaDocument();
  const contents = `${JSON.stringify(document, null, 2)}\n`;

  for (const relativePath of manifestSchemaPaths) {
    const outputPath = join(outputRoot, relativePath);

    mkdirSync(dirname(outputPath), {recursive: true});
    writeFileSync(outputPath, contents);
  }
}

function goIdentifier(token: string): string {
  return token.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function renderGoThemeTokens(): string {
  const fieldNames = PALETTE_CSS_VARIABLES.map((entry) => goIdentifier(entry.token));
  const fieldWidth = Math.max(...fieldNames.map((name) => name.length)) + 1;
  const fields = PALETTE_CSS_VARIABLES
    .map((entry, index) => `\t${fieldNames[index].padEnd(fieldWidth)}string \`json:"${entry.token}"\``)
    .join('\n');

  return `// GENERATED from contracts/tokens.json — do not edit by hand.
package palette

type ThemeTokens struct {
${fields}
}
`;
}

function generateTokenBindings(options: GenerateContractsOptions): void {
  const outputRoot = resolve(options.outputRoot ?? options.repoRoot);
  const tokenNames = PALETTE_CSS_VARIABLES.map((entry) => entry.token);
  const knownTokens = new Set(tokenNames);

  if (knownTokens.size !== tokenNames.length) {
    throw new Error('Palette metadata contains duplicate token names.');
  }

  for (const pair of PALETTE_CONTRAST_PAIRS) {
    if (!knownTokens.has(pair.fg) || !knownTokens.has(pair.bg)) {
      throw new Error(`Palette contrast pair references unknown token: ${pair.fg} on ${pair.bg}`);
    }
  }

  const defaults = {dark: buildPalette('dark'), light: buildPalette('light')};
  const tokenMetadata = PALETTE_CSS_VARIABLES.map((entry) => ({name: entry.token, cssVar: entry.cssVar}));
  const document = {
    schemaVersion: 1,
    tokens: tokenMetadata,
    contrastPairs: PALETTE_CONTRAST_PAIRS,
    defaults,
    scale: SCALE,
  };
  const tokenPath = join(outputRoot, tokenContractPath);
  const sdkTokensPath = join(outputRoot, 'frontend/sdk/src/tokens.ts');
  const sdkCssPath = join(outputRoot, 'frontend/sdk/src/tokens.css');
  const goThemeTokensPath = join(outputRoot, generatedGoThemeTokensPath);

  mkdirSync(dirname(tokenPath), {recursive: true});
  mkdirSync(dirname(sdkTokensPath), {recursive: true});
  mkdirSync(dirname(goThemeTokensPath), {recursive: true});
  writeFileSync(tokenPath, `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(sdkTokensPath, renderTs());
  writeFileSync(sdkCssPath, renderCss());
  writeFileSync(goThemeTokensPath, renderGoThemeTokens());
}

export function generateContracts(options: GenerateContractsOptions): void {
  const repoRoot = resolve(options.repoRoot);
  const outputRoot = resolve(options.outputRoot ?? repoRoot);

  generateManifestSchema({repoRoot, outputRoot});
  generateTokenBindings({repoRoot, outputRoot});
  generateSharedDependencyContracts(repoRoot, outputRoot);

  for (const mapping of fixtureMappings) {
    const sourceRoot = join(mapping.source === 'contracts/protocol' ? outputRoot : repoRoot, mapping.source);

    for (const destination of mapping.destinations) {
      copyDirectory(sourceRoot, join(outputRoot, destination), mapping.include);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(import.meta.dirname, '../..');

  generateContracts({repoRoot});
  console.log(`Generated contract outputs from ${relative(process.cwd(), repoRoot) || '.'}`);
}
