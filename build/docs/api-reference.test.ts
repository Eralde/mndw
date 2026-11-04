import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {Application} from 'typedoc';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const optionsPath = resolve(repoRoot, 'build/docs/typedoc.json');
const optionsRoot = dirname(optionsPath);
const expectedModules = [
  '@mndw/sdk',
  '@mndw/sdk/angular',
  '@mndw/sdk/bind-locale',
  '@mndw/sdk/refresh',
  '@mndw/sdk/rrd',
  '@mndw/sdk/svelte',
  '@mndw/sdk/testing',
  '@mndw/sdk/testing/vitest-project',
  '@mndw/sdk/tokens',
  '@mndw/sdk/vue',
].sort();
const internalNames = [
  'validateManifest',
  'pluginManifestSchema',
  'parseCapabilityList',
  'mwsMemberSchema',
  'createEventSchemaDocument',
  'fetchAll',
];

interface GeneratedApi {
  readonly filePaths: string[];
  readonly modules: string[];
  readonly text: string;
  readonly errors: number;
  readonly warnings: number;
}

let outputDirectory: string;
let generated: GeneratedApi;

function markdownFiles(directory: string): string[] {
  const entries = readdirSync(directory, {withFileTypes: true});
  const paths: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...markdownFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
      paths.push(path);
    }
  }

  return paths;
}

beforeAll(async () => {
  outputDirectory = mkdtempSync(join(tmpdir(), 'mndw-docs-api-'));

  const options = JSON.parse(readFileSync(optionsPath, 'utf8')) as Record<string, unknown>;

  delete options.$schema;

  const entryPoints = options.entryPoints as string[];
  const application = await Application.bootstrapWithPlugins({
    ...options,
    entryPoints: entryPoints.map((entryPoint) => resolve(optionsRoot, entryPoint)),
    tsconfig: resolve(optionsRoot, String(options.tsconfig)),
    docsRoot: resolve(optionsRoot, String(options.docsRoot)),
    out: outputDirectory,
  });
  const project = await application.convert();

  if (project === undefined) {
    throw new Error('TypeDoc could not convert the public SDK entry points.');
  }

  await application.generateOutputs(project);

  const filePaths = markdownFiles(outputDirectory);

  generated = {
    filePaths: filePaths.map((path) => relative(outputDirectory, path)),
    modules: (project.children ?? []).map((child) => child.name).sort(),
    text: filePaths.map((path) => readFileSync(path, 'utf8')).join('\n'),
    errors: application.logger.errorCount,
    warnings: application.logger.warningCount,
  };
}, 180_000);

afterAll(() => {
  if (outputDirectory !== undefined) {
    rmSync(outputDirectory, {recursive: true, force: true});
  }
});

describe('generated SDK API reference', () => {
  it('uses URL-safe output paths', () => {
    expect(generated.filePaths.some((path) => path.includes('@'))).toBe(false);
  }, 120_000);

  it('documents exactly the public SDK modules', () => {
    expect(generated.modules).toEqual(expectedModules);
  }, 120_000);

  it('includes the public PluginContext streams and ticker', () => {
    expect(generated.text).toContain('PluginContext');
    expect(generated.text).toContain('theme$');
    expect(generated.text).toContain('locale$');
    expect(generated.text).toContain('palette$');
    expect(generated.text).toContain('createTicker');
  }, 120_000);

  it('does not expose SDK internals', () => {
    for (const name of internalNames) {
      expect(generated.text).not.toContain(name);
    }
  }, 120_000);

  it('generates without errors or warnings', () => {
    expect(generated.errors).toBe(0);
    expect(generated.warnings).toBe(0);
  }, 120_000);
});
