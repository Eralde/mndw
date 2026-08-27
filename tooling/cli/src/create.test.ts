import {accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {validateManifest} from '@mndw/sdk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {CliError} from './errors.js';
import {type CreateOptions, buildManifest, createPlugin, planCreate, toLabel} from './create.js';
import {readManifest} from './manifest.js';
import {packPlugin} from './pack.js';
import {zipPlugin} from './zip.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

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

  it('renders a vue plugin with an App.vue component and env shim', () => {
    const plan = planCreate(options({name: 'vw', framework: 'vue', type: 'widget'}));

    expect(fileContents(plan, 'src/App.vue')).toContain('Vw');
    expect(fileContents(plan, 'src/App.vue')).not.toContain('__MNDW_LABEL__');
    expect(fileContents(plan, 'src/index.ts')).toContain('App.vue');
    expect(fileContents(plan, 'src/env.d.ts')).toContain('declare module \'*.vue\'');
  });

  it('renders an angular plugin with app.component.ts and angular compiler options', () => {
    const plan = planCreate(options({name: 'ng', framework: 'angular', type: 'widget'}));

    expect(fileContents(plan, 'src/app.component.ts')).toContain('Ng');
    expect(fileContents(plan, 'src/app.component.ts')).toContain('padding:var(--mndw-space-4)');
    expect(fileContents(plan, 'src/app.component.ts')).not.toContain('padding:16px');
    expect(fileContents(plan, 'src/index.ts')).toContain('createAngularPluginInstance');
    expect(fileContents(plan, 'src/index.ts')).toContain('provideTranslator');
    expect(fileContents(plan, 'src/index.ts')).not.toContain('createApplication');
    expect(fileContents(plan, 'src/app.component.ts')).toContain('from \'@mndw/sdk/angular\'');
    expect(JSON.parse(fileContents(plan, 'tsconfig.json'))).toHaveProperty('angularCompilerOptions');
  });

  it('places the SDK and all Angular runtime deps under devDependencies', () => {
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
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('places @mndw/sdk and the framework under devDependencies with empty dependencies', () => {
    const plan = planCreate(options({name: 'vw', framework: 'vue', type: 'widget'}));
    const pkg = JSON.parse(fileContents(plan, 'package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(pkg.devDependencies['@mndw/sdk']).toBeDefined();
    expect(pkg.devDependencies.vue).toBeDefined();
    expect(pkg.devDependencies['@mndw/cli']).toBeDefined();
    expect(pkg.dependencies ?? {}).toEqual({});
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
    expect(insidePkg.devDependencies.svelte).toBeDefined();
    expect(insidePkg.devDependencies['@mndw/cli']).toBe('workspace:*');

    const outsidePlan = planCreate({name: 'outside-plugin', outDir, framework: 'vanilla', type: 'widget'});
    const outsidePkg = JSON.parse(fileContents(outsidePlan, 'package.json')) as {
      devDependencies: Record<string, string>;
    };

    expect(outsidePkg.devDependencies['@mndw/sdk']).toMatch(/^\^/);
    expect(outsidePkg.devDependencies.svelte).toBeUndefined();
  });
});

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

  it('rejects Go outside the repository and incompatible Go combinations before writing', () => {
    const outside = join(root, 'outside-go');
    const widget = join(root, 'widget-go');

    expect(() => createPlugin({name: 'foo', outDir: outside, backend: 'go', type: 'page'})).toThrow(
      /inside the mndw repository/,
    );
    expect(() => createPlugin({name: 'foo', outDir: widget, backend: 'go', type: 'widget'})).toThrow(/vanilla.*page/i);
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
    it(`generates a ${combo.framework} ${combo.type} that validates, packs, and zips`, async () => {
      const outDir = join(root, `${combo.framework}-${combo.type}`);
      const name = `gen-${combo.framework}-${combo.type}`;

      createPlugin({name, outDir, framework: combo.framework, type: combo.type});

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
    });
  }
});
