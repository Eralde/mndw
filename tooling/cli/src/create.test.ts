import {accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {type ChildProcess} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import {validateManifest} from '@mndw/sdk-internal';
import {sharedDependencyVersions} from '@mndw/sdk-internal/shared-dependencies';
import {compile} from 'svelte/compiler';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {CliError} from './errors.js';
import {
  type CreateOptions,
  buildManifest,
  create,
  createPlugin,
  planCreate,
  readCliMetadata,
  toLabel,
} from './create.js';
import {readManifest} from './manifest.js';
import {packPlugin} from './pack.js';
import {zipPlugin} from './zip.js';
import {validatePluginCatalogs} from './i18n-validator.js';
import {runProcess} from './test-process.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
// The full suites run in .github/workflows/ci-weekly.yml.
const skipSlowTests = process.env.MNDW_SKIP_SLOW_TESTS === '1';
const publishedRange = (directory: string): string => {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, directory, 'package.json'), 'utf8')) as {
    version: string;
  };

  return `^${manifest.version}`;
};

describe('readCliMetadata', () => {
  it('uses this CLI package own ranges for Vite and framework plugins', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'tooling/cli/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const metadata = readCliMetadata();
    const range = (name: string): string => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? '';

    expect(metadata.viteRange).toBe(range('vite'));
    expect(metadata.svelteVitePluginRange).toBe(range('@sveltejs/vite-plugin-svelte'));
    expect(metadata.vueVitePluginRange).toBe(range('@vitejs/plugin-vue'));
    expect(metadata.uiRange).toBe(publishedRange('frontend/ui'));
    expect(metadata.uiWrapperRanges).toEqual({
      svelte: publishedRange('frontend/ui-svelte'),
      vue: publishedRange('frontend/ui-vue'),
      angular: publishedRange('frontend/ui-angular'),
    });
  });

  it('throws with the missing package name instead of using a hard-coded range', () => {
    expect(() => readCliMetadata({dependencies: {}, devDependencies: {}})).toThrow('svelte');
  });
});

describe('toLabel', () => {
  it('title-cases a hyphenated plugin name', () => {
    expect(toLabel('my-cool-widget')).toBe('My Cool Widget');
  });

  it('handles a single-word name', () => {
    expect(toLabel('hello')).toBe('Hello');
  });
});

describe('buildManifest', () => {
  let outDir: string;

  const options = (overrides: Partial<CreateOptions> = {}): CreateOptions => ({
    name: 'sample-widget',
    outDir,
    ...overrides,
  });

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'mndw-create-manifest-'));
  });

  afterEach(() => {
    rmSync(outDir, {recursive: true, force: true});
  });

  it('builds a  widget manifest with a grid-unit size', () => {
    const manifest = buildManifest(options({type: 'widget'}));

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.type).toBe('widget');
    expect(manifest.entry).toBe('index.js');

    const size = manifest.size as Record<string, number>;

    expect(typeof size.w).toBe('number');
    expect(typeof size.h).toBe('number');
    expect(size.minW).toBeLessThanOrEqual(size.w);
    expect(size.minH).toBeLessThanOrEqual(size.h);
  });

  it('derives the default label from the name', () => {
    const manifest = buildManifest(options({name: 'traffic-monitor', type: 'widget'}));

    expect(manifest.label).toBe('Traffic Monitor');
  });

  it('defaults a page route to /<name>', () => {
    const manifest = buildManifest(options({name: 'status-page', type: 'page'}));

    expect(manifest.type).toBe('page');
    expect(manifest.route).toBe('/status-page');
    expect(manifest.size).toBeUndefined();
  });

  it('honours an explicit route and label', () => {
    const manifest = buildManifest(
      options({name: 'status-page', type: 'page', route: '/health', label: 'System Health'}),
    );

    expect(manifest.route).toBe('/health');
    expect(manifest.label).toBe('System Health');
  });

  it('adds a exec route for --backend sh', () => {
    const manifest = buildManifest(options({type: 'widget', backend: 'sh'}));
    const backend = manifest.backend as {
      kind: string;
      routes: {id: string; transport: string; method: string; path: string; command: string}[];
    };

    expect(backend.kind).toBe('exec');
    expect(backend.routes).toEqual([{
      id: 'hello',
      transport: 'http',
      method: 'GET',
      path: 'hello',
      command: 'backend/main.sh',
    }]);
  });

  it('adds the fixed service hello contract for --backend go', () => {
    const manifest = buildManifest(options({name: 'foo', type: 'page', backend: 'go'}));

    expect(manifest.backend).toEqual({
      kind: 'service',
      protocolVersion: 1,
      command: 'backend/food',
      routes: [{id: 'hello', transport: 'http', method: 'GET', path: 'hello'}],
    });
  });
});

describe('planCreate', () => {
  let outDir: string;

  const options = (overrides: Partial<CreateOptions> = {}): CreateOptions => ({
    name: 'sample-widget',
    outDir,
    ...overrides,
  });

  const fileContents = (plan: ReturnType<typeof planCreate>, path: string): string => {
    const file = plan.files.find((entry) => entry.path === path);

    if (file === undefined) {
      throw new Error(`expected generated file ${path}, got: ${plan.files.map((f) => f.path).join(', ')}`);
    }

    return file.contents;
  };

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'mndw-create-plan-'));
  });

  afterEach(() => {
    rmSync(outDir, {recursive: true, force: true});
  });

  it('renders a vanilla widget importing @mndw/sdk with host tokens and no placeholders left', () => {
    const plan = planCreate(options({name: 'my-widget', framework: 'vanilla', type: 'widget'}));

    const index = fileContents(plan, 'src/index.ts');
    const css = fileContents(plan, 'src/index.css');

    expect(index).toContain('@mndw/sdk');
    expect(index).toContain('My Widget');
    expect(index).not.toContain('__MNDW_');
    expect(css).toContain('var(--mndw-');
    expect(css).not.toContain('__MNDW_');
  });

  it('emits manifest.json and package.json for every plugin', () => {
    const plan = planCreate(options({name: 'my-widget', framework: 'vanilla', type: 'widget'}));

    const manifest = JSON.parse(fileContents(plan, 'manifest.json')) as {name: string; manifestVersion: number};
    const pkg = JSON.parse(fileContents(plan, 'package.json')) as {
      devDependencies: Record<string, string>;
    };

    expect(manifest.name).toBe('my-widget');
    expect(manifest.manifestVersion).toBe(1);
    expect(pkg.devDependencies['@mndw/sdk']).toBeDefined();
  });

  it('renders a svelte plugin with an App.svelte component', () => {
    const plan = planCreate(options({name: 'sv', framework: 'svelte', type: 'widget'}));

    const app = fileContents(plan, 'src/App.svelte');

    expect(app).toContain('@mndw/sdk');
    expect(app).toContain('var(--mndw-');
    expect(app).not.toContain('__MNDW_');
    expect(fileContents(plan, 'src/index.ts')).toContain('App.svelte');
  });

  it('generates a Svelte template without state_referenced_locally warnings', () => {
    const plan = planCreate(options({name: 'sv', framework: 'svelte', type: 'widget'}));
    const result = compile(fileContents(plan, 'src/App.svelte'), {
      filename: 'src/App.svelte',
      generate: 'client',
      dev: true,
    });

    expect(result.warnings.map((warning) => warning.code)).not.toContain('state_referenced_locally');
  });

  it('renders a vue plugin with an App.vue component and env shim', () => {
    const plan = planCreate(options({name: 'vw', framework: 'vue', type: 'widget'}));

    expect(fileContents(plan, 'src/App.vue')).toContain('Vw');
    expect(fileContents(plan, 'src/App.vue')).not.toContain('__MNDW_LABEL__');
    expect(fileContents(plan, 'src/index.ts')).toContain('App.vue');
    expect(fileContents(plan, 'src/env.d.ts')).toContain('declare module \'*.vue\'');
  });

  it('renders an angular plugin with app.component.ts and angular compiler options', () => {
    const plan = planCreate(options({name: 'ng', framework: 'angular', type: 'widget'}));
    const app = fileContents(plan, 'src/app.component.ts');

    expect(app).toContain('Ng');
    expect(app).toContain('padding:var(--mndw-space-4)');
    expect(app).not.toContain('padding:16px');
    expect(fileContents(plan, 'src/index.ts')).toContain('createAngularPluginInstance');
    expect(fileContents(plan, 'src/index.ts')).toContain('provideTranslator');
    expect(fileContents(plan, 'src/index.ts')).not.toContain('createApplication');
    expect(app).toContain('from \'@mndw/sdk/angular\'');
    expect(app).toContain('MndwTableDirective, MndwCellDirective');
    expect(app).toContain('<mndw-table');
    expect(app).toContain('<ng-template mndwCell="name" let-row>');
    expect(app).not.toContain('angularCell');
    expect(JSON.parse(fileContents(plan, 'tsconfig.json'))).toHaveProperty('angularCompilerOptions');
  });

  it('renders the Angular device name as an input signal', () => {
    const plan = planCreate(options({name: 'ng', framework: 'angular', type: 'widget'}));
    const app = fileContents(plan, 'src/app.component.ts');

    expect(app).toContain(
      'import {CUSTOM_ELEMENTS_SCHEMA, Component, InjectionToken, computed, inject, input, signal} from \'@angular/core\';',
    );
    expect(app).toContain('public readonly deviceName = input(\'\');');
    expect(app).toContain('<p>Device: {{ deviceName() }}</p>');
    expect(app).not.toMatch(/\bInput\b/);
  });

  it.skipIf(skipSlowTests)('runs generated framework locale and table tests without compiler warnings', async () => {
    const root = mkdtempSync(join(REPO_ROOT, 'tooling', 'cli', '.generated-warning-'));
    const vitest = join(REPO_ROOT, 'tooling', 'cli', 'node_modules', '.bin', 'vitest');

    try {
      for (const framework of ['svelte', 'vue', 'angular'] as const) {
        const generatedDir = join(root, framework);

        createPlugin({name: `warning-${framework}`, outDir: generatedDir, framework, type: 'widget'});

        const result = await runProcess(vitest, ['run', 'src/l10n.test.ts', 'src/table.test.ts'], {cwd: generatedDir});
        const output = `${result.stdout}\n${result.stderr}`;

        expect(result.status, output).toBe(0);
        expect(output).not.toContain('state_referenced_locally');
        expect(output).not.toContain('NG0303');
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }, 60_000);

  it('places the Angular UI packages under dependencies and Angular tooling under devDependencies', () => {
    const plan = planCreate(options({name: 'ng', framework: 'angular', type: 'widget'}));
    const pkg = JSON.parse(fileContents(plan, 'package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    for (
      const dep of [
        '@mndw/sdk',
        '@angular/core',
        '@angular/common',
        '@angular/platform-browser',
        '@angular/compiler',
        'zone.js',
        'typescript',
      ]
    ) {
      expect(pkg.devDependencies[dep]).toBeDefined();
    }

    expect(pkg.devDependencies['@angular/compiler-cli']).toBeUndefined();
    expect(pkg.dependencies).toEqual({
      '@mndw/ui': publishedRange('frontend/ui'),
      '@mndw/ui-angular': publishedRange('frontend/ui-angular'),
    });
  });

  it('places Vue UI packages under dependencies and framework tooling under devDependencies', () => {
    const plan = planCreate(options({name: 'vw', framework: 'vue', type: 'widget'}));
    const pkg = JSON.parse(fileContents(plan, 'package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(pkg.devDependencies['@mndw/sdk']).toBeDefined();
    expect(pkg.devDependencies.vue).toBeDefined();
    expect(pkg.devDependencies['@mndw/cli']).toBeDefined();
    expect(pkg.dependencies).toEqual({
      '@mndw/ui': publishedRange('frontend/ui'),
      '@mndw/ui-vue': publishedRange('frontend/ui-vue'),
    });
  });

  it('generates live i18n regression tests and test dependencies from CLI metadata', () => {
    for (const framework of ['vanilla', 'svelte', 'vue', 'angular'] as const) {
      const plan = planCreate(options({name: `${framework}-plugin`, framework, type: 'widget'}));
      const pkg = JSON.parse(fileContents(plan, 'package.json')) as {
        scripts?: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const test = fileContents(plan, 'src/l10n.test.ts');

      expect(test).toContain('createTestI18n');
      expect(test).toContain('setLocale');
      expect(pkg.scripts?.test).toBe('vitest run');
      expect(pkg.devDependencies.vitest).toBe('^3.2.7');
      expect(pkg.devDependencies['happy-dom']).toBe('^20.11.1');
      expect(pkg.devDependencies).not.toHaveProperty('intl-messageformat');
    }
  });

  it.each(['svelte', 'vue', 'angular', 'vanilla'] as const)(
    'generates matching English and Russian catalogs for %s',
    (framework) => {
      const plan = planCreate(options({name: `${framework}-plugin`, framework, type: 'widget'}));
      const files = new Map(plan.files.map((file) => [file.path, file]));
      const rawManifest = JSON.parse(files.get('manifest.json')?.contents ?? '{}') as {
        i18n?: {defaultLocale: string; locales: Record<string, string>};
      };

      expect(rawManifest.i18n).toEqual({
        defaultLocale: 'en',
        locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'},
      });

      const i18n = rawManifest.i18n;

      if (i18n === undefined) {
        return;
      }

      const manifest = validateManifest(rawManifest);
      const pluginDir = join(outDir, framework);
      const catalogs = new Map<string, Record<string, unknown>>();

      for (const [locale, catalogPath] of Object.entries(i18n.locales)) {
        const file = files.get(catalogPath);

        expect(file, `${framework} plan is missing ${catalogPath}`).toBeDefined();

        if (file === undefined) {
          continue;
        }

        const destination = join(pluginDir, catalogPath);

        mkdirSync(dirname(destination), {recursive: true});
        writeFileSync(destination, file.contents);
        catalogs.set(locale, JSON.parse(file.contents) as Record<string, unknown>);
      }

      const source = plan.files
        .filter((file) =>
          file.path.startsWith('src/') && /\.(?:ts|tsx|js|vue|svelte)$/.test(file.path)
          && !file.path.includes('.test.')
        )
        .map((file) => file.contents)
        .join('\n');
      const keys = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1] ?? '');

      expect(keys.length).toBeGreaterThan(0);

      for (const [locale, catalog] of catalogs) {
        for (const key of keys) {
          const message = key.split('.').reduce<unknown>((value, segment) => {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
              return undefined;
            }

            return (value as Record<string, unknown>)[segment];
          }, catalog);

          expect(message, `${framework} ${locale} is missing ${key}`).toBeTypeOf('string');
        }
      }

      expect(validatePluginCatalogs(pluginDir, manifest, {strict: false})).toEqual([]);
    },
  );

  it('requires ctx.i18n in every generated framework entry', () => {
    for (const framework of ['vanilla', 'svelte', 'vue', 'angular'] as const) {
      const plan = planCreate(options({name: `${framework}-plugin`, framework, type: 'widget'}));
      const source = plan.files
        .filter((file) =>
          file.path.startsWith('src/') && !file.path.endsWith('.css') && !file.path.endsWith('.test.ts')
        )
        .map((file) => file.contents)
        .join('\n');

      expect(source).toContain('ctx.i18n');
      expect(source).not.toContain('FALLBACK_I18N');
      expect(source).not.toContain('providedI18n ??');
    }
  });

  it('adds an executable backend command for --backend sh', () => {
    const plan = planCreate(options({type: 'widget', backend: 'sh'}));

    const script = plan.files.find((entry) => entry.path === 'backend/main.sh');

    expect(script).toBeDefined();
    expect(script?.executable).toBe(true);
    expect(script?.contents).not.toContain('__MNDW_');
    expect(script?.contents.startsWith('#!/bin/sh')).toBe(true);
  });

  it('omits a backend directory when no backend is requested', () => {
    const plan = planCreate(options({type: 'widget'}));

    expect(plan.files.some((entry) => entry.path.startsWith('backend/'))).toBe(false);
  });

  it('renders a complete Go page scaffold with aligned backend consumers', () => {
    const plan = planCreate({
      name: 'foo',
      backend: 'go',
      framework: 'vanilla',
      type: 'page',
      outDir: join(REPO_ROOT, 'tooling', 'cli', '.go-plan-fixture'),
    });
    const file = (path: string): string => {
      const found = plan.files.find((entry) => entry.path === path);

      if (found === undefined) {
        throw new Error(`missing generated file: ${path}`);
      }

      return found.contents;
    };
    const rawManifest = JSON.parse(file('manifest.json')) as Record<string, unknown>;
    const validated = validateManifest(rawManifest);
    const backend = validated.backend;

    expect(rawManifest.backend).toEqual({
      kind: 'service',
      protocolVersion: 1,
      command: 'backend/food',
      routes: [{id: 'hello', transport: 'http', method: 'GET', path: 'hello'}],
    });
    expect(rawManifest.i18n).toEqual({
      defaultLocale: 'en',
      locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'},
    });
    expect(backend?.routes.find((route) => route.id === 'hello')?.access).toBe('session');
    expect(file('backend/internal/httpapi/server.go')).toContain('mux.HandleFunc("GET /hello"');
    expect(file('src/index.ts')).toContain('ctx.backend.fetch(\'hello\')');
    expect(file('src/index.ts')).toContain('button?.addEventListener(\'click\'');
    expect(file('i18n/en.json')).toContain('Backend response');
    expect(file('i18n/ru.json')).toContain('Ответ сервера');

    const pkg = JSON.parse(file('package.json')) as {
      mndw?: {backend?: {binaryName?: string; entryPackage?: string}};
      scripts?: Record<string, string>;
    };

    expect(pkg.mndw?.backend).toEqual({binaryName: 'food', entryPackage: './cmd/food'});
    expect(pkg.scripts?.['build-backend']).toBe('mndw build-backend');
    expect(plan.files.some((entry) => entry.path === ['scripts', 'build-backend.ts'].join('/'))).toBe(false);
    expect(plan.files.map((entry) => entry.path).sort()).toEqual([
      '.gitignore',
      'backend/cmd/food/main.go',
      'backend/go.mod',
      'backend/integration_test.go',
      'backend/internal/httpapi/server.go',
      'backend/internal/httpapi/server_test.go',
      'i18n/en.json',
      'i18n/ru.json',
      'manifest.json',
      'package.json',
      'src/index.css',
      'src/index.test.ts',
      'src/index.ts',
      'src/l10n.test.ts',
      'src/test-helpers.ts',
    ]);

    for (const entry of plan.files) {
      expect(entry.contents).not.toContain('__MNDW_');
      expect(entry.contents).not.toContain('mndw.local/');
    }
  });

  it('uses workspace dependencies inside the repo and version ranges outside it', () => {
    const insidePlan = planCreate({
      name: 'inside-plugin',
      outDir: join(REPO_ROOT, 'packages', 'cli', 'inside-plugin-scaffold'),
      framework: 'svelte',
      type: 'widget',
    });
    const insidePkg = JSON.parse(fileContents(insidePlan, 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(insidePkg.devDependencies['@mndw/sdk']).toBe('workspace:*');
    expect(insidePkg.dependencies).toEqual({'@mndw/ui': 'workspace:*', '@mndw/ui-svelte': 'workspace:*'});
    expect(insidePkg.devDependencies.svelte).toBeDefined();
    expect(insidePkg.devDependencies['@mndw/cli']).toBe('workspace:*');

    const outsidePlan = planCreate({name: 'outside-plugin', outDir, framework: 'vanilla', type: 'widget'});
    const outsidePkg = JSON.parse(fileContents(outsidePlan, 'package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(outsidePkg.devDependencies['@mndw/sdk']).toMatch(/^\^/);
    expect(outsidePkg.devDependencies.svelte).toBeUndefined();
    expect(outsidePkg.dependencies ?? {}).toEqual({});
  });

  it('adds rxjs and @rci-tools/core as type-only devDependencies outside the repo', () => {
    const outsidePlan = planCreate({name: 'outside-plugin', outDir, framework: 'vanilla', type: 'widget'});
    const outsidePkg = JSON.parse(fileContents(outsidePlan, 'package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const versions = sharedDependencyVersions();

    expect(outsidePkg.devDependencies.rxjs).toBe(`^${versions.rxjs}`);
    expect(outsidePkg.devDependencies['@rci-tools/core']).toBe(`^${versions['@rci-tools/core']}`);
    expect(outsidePkg.dependencies ?? {}).toEqual({});
  });
});

function installAngularUiCompilerFixtures(pluginDir: string): void {
  const packageRoot = join(pluginDir, 'node_modules', '@mndw');
  const uiRoot = join(packageRoot, 'ui');
  const angularRoot = join(packageRoot, 'ui-angular');

  mkdirSync(uiRoot, {recursive: true});
  mkdirSync(angularRoot, {recursive: true});
  writeFileSync(join(uiRoot, 'package.json'), JSON.stringify({name: '@mndw/ui', types: './index.ts'}));
  writeFileSync(
    join(uiRoot, 'index.ts'),
    `export interface Column<Row> { id: string; label: string; accessor: (row: Row) => unknown; }
export declare function defineMndwUi(): void;
export declare function column<Row>(): (definition: Column<Row>) => Column<Row>;
`,
  );
  writeFileSync(join(angularRoot, 'package.json'), JSON.stringify({name: '@mndw/ui-angular', types: './index.ts'}));
  writeFileSync(
    join(angularRoot, 'index.ts'),
    `import {Directive, Input} from '@angular/core';
import type {Column} from '@mndw/ui';

@Directive({selector: 'mndw-table', standalone: true})
export class MndwTableDirective {
  @Input() public columns: Column<unknown>[] = [];
}

@Directive({selector: '[mndwCell]', standalone: true})
export class MndwCellDirective<Row = unknown> {
  @Input('mndwCell') public id = '';
  public static ngTemplateContextGuard<Row>(
    _directive: MndwCellDirective<Row>,
    _context: unknown,
  ): _context is {$implicit: Row} {
    return true;
  }
}
`,
  );
}

function createStreams(): {input: PassThrough; output: PassThrough} {
  return {input: new PassThrough(), output: new PassThrough()};
}

describe('createPlugin', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mndw-create-write-'));
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  it('rejects an invalid plugin name before writing anything', () => {
    const outDir = join(root, 'bad');

    expect(() => createPlugin({name: 'Bad Name', outDir, type: 'widget'})).toThrow(CliError);
    expect(existsSync(outDir)).toBe(false);
  });

  it('rejects a reserved page route before writing anything', () => {
    const outDir = join(root, 'reserved');

    expect(() => createPlugin({name: 'settings-clone', outDir, type: 'page', route: '/settings'})).toThrow(CliError);
    expect(existsSync(outDir)).toBe(false);
  });

  it('creates Go pages outside the repository with published package ranges', async () => {
    const outside = join(root, 'outside-go');
    const io = createStreams();

    const result = await create({
      name: 'foo',
      outDir: outside,
      backend: 'go',
      framework: 'vanilla',
      type: 'page',
      noInstall: true,
    }, {
      cwd: root,
      env: {},
      stdin: io.input,
      stdout: io.output,
      spawn: vi.fn(),
    });

    const outsidePackage = JSON.parse(readFileSync(join(outside, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const cliPackage = JSON.parse(readFileSync(resolve(REPO_ROOT, 'tooling/cli/package.json'), 'utf8')) as {
      version: string;
    };
    const sdkPackage = JSON.parse(readFileSync(resolve(REPO_ROOT, 'frontend/sdk/package.json'), 'utf8')) as {
      version: string;
    };
    const cliMetadata = readCliMetadata();

    expect(result.plan.framework).toBe('vanilla');
    expect(outsidePackage.devDependencies['@mndw/cli']).toBe(`^${cliPackage.version}`);
    expect(outsidePackage.devDependencies['@mndw/sdk']).toBe(`^${sdkPackage.version}`);
    expect(outsidePackage.devDependencies.tsx).toBe(cliMetadata.tsxRange);
    expect(outsidePackage.devDependencies.vitest).toBe(cliMetadata.vitestRange);
    expect(outsidePackage.devDependencies['happy-dom']).toBe(cliMetadata.happyDomRange);
    expect(JSON.stringify(outsidePackage)).not.toContain('workspace:');
  });

  it('rejects Go backends with incompatible frameworks or plugin types before writing', () => {
    const outside = join(root, 'outside-go-widget');
    const widget = join(root, 'widget-go');

    expect(() => createPlugin({name: 'foo', outDir: outside, backend: 'go', framework: 'svelte', type: 'page'}))
      .toThrow('--backend go requires --framework vanilla and --type page');
    expect(() =>
      createPlugin({
        name: 'foo',
        outDir: widget,
        backend: 'go',
        framework: 'vanilla',
        type: 'widget',
      })
    ).toThrow(/vanilla.*page/i);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(widget)).toBe(false);
  });

  it('refuses a non-empty destination and leaves pre-existing files untouched', () => {
    const occupied = join(root, 'occupied');

    mkdirSync(occupied, {recursive: true});
    writeFileSync(join(occupied, 'keep.txt'), 'keep');

    expect(() => createPlugin({name: 'widget', outDir: occupied, type: 'widget'})).toThrow(/not empty/);
    expect(readFileSync(join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(occupied, 'manifest.json'))).toBe(false);
  });

  it('writes an executable backend command and a plain manifest', () => {
    const outDir = join(root, 'be');

    createPlugin({name: 'be-widget', outDir, type: 'widget', backend: 'sh'});

    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(outDir, 'backend', 'main.sh'))).toBe(true);
    // Executable bit set — accessSync throws if the file is not executable.
    expect(() => accessSync(join(outDir, 'backend', 'main.sh'), constants.X_OK)).not.toThrow();
  });

  it('writes the Go template gitignore as .gitignore', () => {
    const outDir = join(REPO_ROOT, 'tooling/cli/.go-gitignore-scaffold');

    try {
      createPlugin({name: 'go-page', outDir, backend: 'go', framework: 'vanilla', type: 'page'});

      expect(existsSync(join(outDir, '.gitignore'))).toBe(true);
      expect(existsSync(join(outDir, 'gitignore'))).toBe(false);
    } finally {
      rmSync(outDir, {recursive: true, force: true});
    }
  });

  const combos: {framework: 'vanilla' | 'svelte' | 'vue' | 'angular'; type: 'widget' | 'page'}[] = [
    {framework: 'vanilla', type: 'widget'},
    {framework: 'vanilla', type: 'page'},
    {framework: 'svelte', type: 'widget'},
    {framework: 'svelte', type: 'page'},
    {framework: 'vue', type: 'widget'},
    {framework: 'vue', type: 'page'},
    {framework: 'angular', type: 'widget'},
    {framework: 'angular', type: 'page'},
  ];

  for (const combo of combos) {
    it.skipIf(skipSlowTests)(
      `generates a ${combo.framework} ${combo.type} that validates, packs, and zips`,
      async () => {
        const outDir = join(root, `${combo.framework}-${combo.type}`);
        const name = `gen-${combo.framework}-${combo.type}`;

        createPlugin({name, outDir, framework: combo.framework, type: combo.type});

        if (combo.framework === 'angular') {
          installAngularUiCompilerFixtures(outDir);
        }

        // validate
        expect(readManifest(outDir).manifest.name).toBe(name);

        // pack
        const packed = await packPlugin(outDir);

        expect(packed.framework).toBe(combo.framework);
        expect(existsSync(join(outDir, 'dist', 'index.js'))).toBe(true);

        if (combo.framework !== 'angular') {
          expect(existsSync(join(outDir, 'dist', 'index.css'))).toBe(true);
        }

        // zip
        const zipped = await zipPlugin(outDir);

        expect(existsSync(zipped.outputPath)).toBe(true);
      },
    );
  }
});

describe('create package installation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mndw-create-command-'));
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  it('installs outside the repository with the invoking package manager', async () => {
    const outDir = join(root, 'new-plugin');
    const io = createStreams();
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);
    const result = create({
      name: 'new-plugin',
      outDir,
    }, {
      cwd: root,
      env: {npm_config_user_agent: 'pnpm/10.0.0 npm/? node/v22.0.0'},
      stdin: io.input,
      stdout: io.output,
      spawn,
    });

    queueMicrotask(() => child.emit('close', 0, null));
    await expect(result).resolves.toMatchObject({plan: {framework: 'svelte'}});
    expect(spawn).toHaveBeenCalledWith('pnpm', ['install'], {cwd: outDir, stdio: 'inherit'});
  });

  it('does not spawn an installer with --no-install', async () => {
    const outDir = join(root, 'no-install');
    const io = createStreams();
    const spawn = vi.fn();

    await create({name: 'no-install', outDir, noInstall: true}, {
      cwd: root,
      env: {},
      stdin: io.input,
      stdout: io.output,
      spawn,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(outDir, 'src', 'App.svelte'))).toBe(true);
  });

  it('keeps the scaffold when dependency installation fails', async () => {
    const outDir = join(root, 'install-fails');
    const io = createStreams();
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);
    const result = create({name: 'install-fails', outDir}, {
      cwd: root,
      env: {npm_config_user_agent: 'pnpm/10.0.0'},
      stdin: io.input,
      stdout: io.output,
      spawn,
    });

    queueMicrotask(() => child.emit('close', 1, null));
    await expect(result).rejects.toThrow(/pnpm install/);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
  });
});

describe('create defaults and workspace behavior', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mndw-create-command-'));
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  it('uses Svelte without a prompt when stdin or stdout is not a TTY', async () => {
    const outDir = join(root, 'non-interactive');
    const io = createStreams();
    const result = await create({name: 'non-interactive', outDir, noInstall: true}, {
      cwd: root,
      env: {},
      stdin: io.input,
      stdout: io.output,
      spawn: vi.fn(),
    });

    expect(result.plan.framework).toBe('svelte');
    expect(existsSync(join(outDir, 'src', 'App.svelte'))).toBe(true);
  });

  it('writes publishable UI dependency ranges for outside-workspace scaffolds', async () => {
    const io = createStreams();

    for (const framework of ['svelte', 'vue', 'angular'] as const) {
      const outDir = join(root, `${framework}-outside`);

      await create({name: `${framework}-outside`, framework, outDir, noInstall: true}, {
        cwd: REPO_ROOT,
        env: {},
        stdin: io.input,
        stdout: io.output,
        spawn: vi.fn(),
      });

      const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const serialized = JSON.stringify(pkg);

      expect(serialized).not.toContain('workspace:');
      expect(pkg.dependencies).toMatchObject({
        '@mndw/ui': publishedRange('frontend/ui'),
        [`@mndw/ui-${framework}`]: publishedRange(`frontend/ui-${framework}`),
      });
    }
  });

  it('does not install inside the repository and prints the workspace instruction', async () => {
    const outDir = mkdtempSync(join(REPO_ROOT, 'tooling/cli/.create-in-repo-'));
    const io = createStreams();

    io.output.setEncoding('utf8');

    let written = '';

    io.output.on('data', (chunk: string) => {
      written += chunk;
    });

    const spawn = vi.fn();

    try {
      await create({name: 'in-repo', outDir}, {
        cwd: REPO_ROOT,
        env: {},
        stdin: io.input,
        stdout: io.output,
        spawn,
      });

      expect(spawn).not.toHaveBeenCalled();
      expect(written).toContain('Run pnpm install from the repository root.');
    } finally {
      rmSync(outDir, {recursive: true, force: true});
    }
  });
});
