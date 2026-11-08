import {copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  EVENT_PERMISSION_PATTERN,
  PERSISTENT_RCI_PERMISSIONS,
  createEventSchemaDocument,
  createManifestSchemaDocument,
  createMwsMemberSchemaDocument,
} from '@mndw/sdk-internal';
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
  {
    source: 'contracts/mws-member/fixtures',
    destinations: ['frontend/sdk/fixtures/mws-members', 'packages/go-mws-members/fixtures'],
  },
  {
    source: 'contracts/rci-session/fixtures/capability',
    destinations: [
      'frontend/host/src/services/fixtures/rci-session/capability',
      'daemon/mndwd/internal/rcisession/testdata/capability',
    ],
  },
  {
    source: 'contracts/events/fixtures',
    destinations: [
      'frontend/sdk/fixtures/events',
      'daemon/contracts-go/fixtures/events',
      'daemon/mndwd/internal/events/fixtures',
    ],
  },
  {
    source: 'contracts/mgmt/fixtures',
    destinations: ['daemon/mndwd/internal/mgmt/fixtures/mgmt', 'frontend/host/src/runtime/fixtures/mgmt'],
  },
];

const manifestSchemaPaths = [
  'contracts/manifest/manifest.schema.json',
  'frontend/sdk/manifest.schema.json',
] as const;

const mwsMemberSchemaPath = 'contracts/mws-member/mws-member.schema.json';
const rciSessionStatusCategoriesPath = 'contracts/rci-session/status-categories.json';
const hostRciSessionStatusCategoriesPath = 'frontend/host/src/services/rci-session-status-categories.ts';

const tokenContractPath = 'contracts/tokens.json';
const generatedGoThemeTokensPath = 'daemon/mndwd/internal/palette/theme_tokens_generated.go';
const eventSchemaPath = 'contracts/events/events.schema.json';
const generatedGoEventsPath = 'daemon/contracts-go/events/events.go';
const generatedGoPermissionsPath = 'daemon/contracts-go/manifest/permissions_generated.go';

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

type JsonSchema = Record<string, unknown>;

const asJsonSchema = (value: unknown, label: string): JsonSchema => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as JsonSchema;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }

  return value;
};

const asStringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a string array`);
  }

  return value;
};

const asSchemaArray = (value: unknown, label: string): JsonSchema[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((item, index) => asJsonSchema(item, `${label}[${index}]`));
};

const schemaLiterals = (schema: JsonSchema, label: string): string[] => {
  if (typeof schema.const === 'string') {
    return [schema.const];
  }

  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === 'string')) {
    return schema.enum;
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.flatMap((value, index) =>
      schemaLiterals(
        asJsonSchema(value, `${label}.anyOf[${index}]`),
        `${label}.anyOf[${index}]`,
      )
    );
  }

  throw new Error(`${label} must contain string literals`);
};

const initialisms: Readonly<Record<string, string>> = {
  id: 'ID',
  ip: 'IP',
  mac: 'MAC',
  rci: 'RCI',
  ssid: 'SSID',
  usb: 'USB',
};

const goFieldName = (name: string): string => {
  return name.split('_').map((part) => {
    return initialisms[part] ?? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
  })
    .join('');
};

export const goType = (schema: JsonSchema, path: string): string => {
  if (schema.anyOf !== undefined || schema.enum !== undefined || Array.isArray(schema.type)) {
    throw new Error(`unsupported JSON schema construct at ${path}`);
  }

  const schemaType = schema.type;

  if (schemaType === 'string') {
    return 'string';
  }

  if (schemaType === 'integer' || schemaType === 'number') {
    return 'int64';
  }

  if (schemaType === 'boolean') {
    return 'bool';
  }

  if (schemaType === 'array') {
    const itemsPath = `${path}.items`;

    return `[]${goType(asJsonSchema(schema.items, itemsPath), itemsPath)}`;
  }

  if (schemaType === 'object') {
    return 'json.RawMessage';
  }

  throw new Error(`unsupported JSON schema construct at ${path}`);
};

const topicTypeName = (topic: string): string => {
  return topic.split('.').map(goFieldName)
    .join('');
};

function renderGoEvents(document: JsonSchema): string {
  const branches = asSchemaArray(document.anyOf, 'event schema anyOf');
  const rows = branches.map((branch, index) => {
    const properties = asJsonSchema(branch.properties, `event branch ${index} properties`);
    const topicSchema = asJsonSchema(properties.topic, `event branch ${index} topic`);
    const sourceSchema = asJsonSchema(properties.source, `event branch ${index} source`);
    const payloadSchema = asJsonSchema(properties.payload, `event branch ${index} payload`);
    const payloadProperties = asJsonSchema(payloadSchema.properties, `event branch ${index} payload properties`);
    const topic = asString(topicSchema.const, `event branch ${index} topic`);

    return {
      topic,
      sources: schemaLiterals(sourceSchema, `event branch ${index} source`),
      payloadName: `${topicTypeName(topic)}Payload`,
      payloadProperties,
      required: new Set(asStringArray(payloadSchema.required ?? [], `event branch ${index} payload required`)),
    };
  });

  const payloadStructs = rows.map((row) => {
    const fields = Object.entries(row.payloadProperties).map(([name, rawSchema]) => {
      const schema = asJsonSchema(rawSchema, `payload field ${row.topic}.${name}`);
      const path = `payload field ${row.topic}.${name}`;
      const optional = !row.required.has(name);
      const type = optional ? `*${goType(schema, path)}` : goType(schema, path);
      const jsonTag = optional ? `${name},omitempty` : name;

      return `\t${goFieldName(name).padEnd(20)} ${type.padEnd(18)} \`json:"${jsonTag}"\``;
    });

    return `type ${row.payloadName} struct {\n${fields.join('\n')}\n}`;
  }).join('\n\n');

  const sourceConstants = ['hook', 'log', 'internal']
    .map((source) => `\tSource${goFieldName(source)} Source = "${source}"`)
    .join('\n');
  const topicConstants = rows
    .map((row) => `\tTopic${row.payloadName.slice(0, -'Payload'.length)} Topic = "${row.topic}"`)
    .join('\n');

  return `// GENERATED from frontend/sdk/src/event-schema.ts — do not edit by hand.
package events

import "encoding/json"

type Source string

const (
${sourceConstants}
)

type Topic string

const (
${topicConstants}
)

type Event struct {
\tID      string          \`json:"id"\`
\tTs      int64           \`json:"ts"\`
\tTopic   Topic           \`json:"topic"\`
\tSource  Source          \`json:"source"\`
\tPayload json.RawMessage \`json:"payload"\`
}

${payloadStructs}
`;
}

function generateEventContracts(options: GenerateContractsOptions): void {
  const outputRoot = resolve(options.outputRoot ?? options.repoRoot);
  const document = createEventSchemaDocument();
  const schemaPath = join(outputRoot, eventSchemaPath);
  const goPath = join(outputRoot, generatedGoEventsPath);

  mkdirSync(dirname(schemaPath), {recursive: true});
  mkdirSync(dirname(goPath), {recursive: true});
  writeFileSync(schemaPath, `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(goPath, renderGoEvents(document));
  execFileSync('gofmt', ['-w', goPath], {stdio: 'pipe'});
}

const goPermissionConstName = (permission: string): string => {
  return `${goFieldName(permission.replace(/[-:]/g, '_'))}Permission`;
};

function renderGoPermissions(): string {
  const pattern = EVENT_PERMISSION_PATTERN.source;

  if (EVENT_PERMISSION_PATTERN.flags !== '' || pattern.includes('`')) {
    throw new Error('EVENT_PERMISSION_PATTERN must be flag-free and contain no backtick to render as a Go raw string.');
  }

  const constants = PERSISTENT_RCI_PERMISSIONS
    .map((permission) => `\t${goPermissionConstName(permission)} = "${permission}"`)
    .join('\n');
  const listItems = PERSISTENT_RCI_PERMISSIONS
    .map((permission) => `\t\t${goPermissionConstName(permission)},`)
    .join('\n');

  return `// GENERATED from frontend/sdk/src/permissions.ts — do not edit by hand.
package manifest

const (
${constants}
)

// persistentRCIPermissions returns every grantable persistent RCI permission in
// authority order. It returns a fresh slice so callers cannot mutate the set.
func persistentRCIPermissions() []string {
\treturn []string{
${listItems}
\t}
}

const eventPermissionPattern = \`${pattern}\`
`;
}

function generateGoPermissions(options: GenerateContractsOptions): void {
  const outputRoot = resolve(options.outputRoot ?? options.repoRoot);
  const goPath = join(outputRoot, generatedGoPermissionsPath);

  mkdirSync(dirname(goPath), {recursive: true});
  writeFileSync(goPath, renderGoPermissions());
  execFileSync('gofmt', ['-w', goPath], {stdio: 'pipe'});
}

function generateMwsMemberSchema(options: GenerateContractsOptions): void {
  const outputRoot = resolve(options.outputRoot ?? options.repoRoot);
  const outputPath = join(outputRoot, mwsMemberSchemaPath);
  const document = createMwsMemberSchemaDocument();

  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
}

function generateRciSessionStatusCategories(options: GenerateContractsOptions): void {
  const outputRoot = resolve(options.outputRoot ?? options.repoRoot);
  const jsonPath = join(outputRoot, rciSessionStatusCategoriesPath);
  const daemonRoot = join(options.repoRoot, 'daemon/mndwd');

  execFileSync('go', ['run', './cmd/generate-rci-session-contract', '--output', jsonPath], {
    cwd: daemonRoot,
    env: {...process.env, GOCACHE: resolve(options.repoRoot, '.cache/go-build')},
    stdio: 'pipe',
  });

  const categories = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;

  if (!Array.isArray(categories) || !categories.every((value): value is string => typeof value === 'string')) {
    throw new Error('Generated RCI session status categories must be a string array.');
  }

  const hostPath = join(outputRoot, hostRciSessionStatusCategoriesPath);

  mkdirSync(dirname(hostPath), {recursive: true});

  const renderedCategories = categories.map((category) => `  '${category}',`).join('\n');

  writeFileSync(
    hostPath,
    `// GENERATED from daemon/mndwd/internal/rcisession/status — do not edit by hand.\nexport const persistentFailureCategories = [\n${renderedCategories}\n] as const;\n`,
  );
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

  return `// GENERATED from tooling/palette-core/src/metadata.ts — do not edit by hand.
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
  generateEventContracts({repoRoot, outputRoot});
  generateGoPermissions({repoRoot, outputRoot});
  generateMwsMemberSchema({repoRoot, outputRoot});
  generateRciSessionStatusCategories({repoRoot, outputRoot});
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
