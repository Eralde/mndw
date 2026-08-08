import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {validateManifest} from '@mndw/sdk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const renameFailure = vi.hoisted(() => ({destination: undefined as string | undefined, remaining: 0}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  return {
    ...actual,
    renameSync: (source: string, destination: string): void => {
      if (destination === renameFailure.destination && renameFailure.remaining > 0) {
        renameFailure.remaining--;
        throw new Error('simulated promotion failure');
      }

      actual.renameSync(source, destination);
    },
  };
});

import {CliError} from './errors.js';
import {packExamplePlugins, packPlugin} from './pack.js';

interface ScaffoldOptions {
  readonly manifest: Record<string, unknown>;
  readonly index?: string;
  readonly files?: Readonly<Record<string, string>>;
}

function scaffold(dir: string, options: ScaffoldOptions): void {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(options.manifest, null, 2));

  if (options.index !== undefined) {
    mkdirSync(join(dir, 'src'), {recursive: true});
    writeFileSync(join(dir, 'src', 'index.ts'), options.index);
  }

  for (const [rel, contents] of Object.entries(options.files ?? {})) {
    const full = join(dir, rel);

    mkdirSync(join(full, '..'), {recursive: true});
    writeFileSync(full, contents);
  }
}

function widgetManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 3,
    name: 'sample-widget',
    version: '0.1.0',
    type: 'widget',
    label: 'Sample',
    entry: 'index.js',
    size: {w: 3, h: 2},
    ...overrides,
  };
}

describe('packPlugin', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mndw-pack-'));
  });

  afterEach(() => {
    renameFailure.destination = undefined;
    renameFailure.remaining = 0;
    rmSync(dir, {recursive: true, force: true});
  });

  it('bundles a vanilla plugin to dist/<entry> with a validated manifest', async () => {
    scaffold(dir, {
      manifest: widgetManifest(),
      index: 'export const createInstance = () => ({unmount() {}});\n',
    });

    const result = await packPlugin(dir);

    expect(result.framework).toBe('vanilla');
    expect(result.outDir).toBe(join(dir, 'dist'));
    expect(existsSync(join(dir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(dir, 'dist', 'manifest.json'))).toBe(true);

    const packedManifest = JSON.parse(readFileSync(join(dir, 'dist', 'manifest.json'), 'utf8')) as {name: string};

    expect(packedManifest.name).toBe('sample-widget');
  });

  it('emits target-independent artifact metadata and omits compiled backend assets', async () => {
    scaffold(dir, {
      manifest: widgetManifest({
        name: 'compiled-widget',
        backend: {
          kind: 'exec',
          routes: [{id: 'status', transport: 'http', method: 'GET', path: 'status', command: 'backend/status.sh'}],
        },
      }),
      index: 'export const createInstance = () => ({unmount() {}});\n',
      files: {'package.json': JSON.stringify({mndw: {backendBuildScript: 'build-backend'}}, null, 2),
        'backend/status.sh': '#!/bin/sh\n'},
    });

    await packPlugin(dir);

    const artifact = JSON.parse(readFileSync(join(dir, 'dist', 'mndw-artifact.json'), 'utf8')) as {
      plugin: string;
      staticBackends: string[];
    };

    expect(artifact).toEqual({
      schemaVersion: 1,
      plugin: 'compiled-widget',
      entry: 'index.js',
      staticBackends: ['backend/status.sh'],
    });
    expect(existsSync(join(dir, 'dist', 'backend', 'mndwd'))).toBe(false);
    expect(existsSync(join(dir, 'dist', 'backend', 'status.sh'))).toBe(true);
  });

  it('stages each v3 backend command once with executable mode', async () => {
    scaffold(dir, {
      manifest: {
        manifestVersion: 3,
        name: 'exec-v3-widget',
        version: '0.1.0',
        type: 'widget',
        label: 'Exec V3',
        entry: 'index.js',
        size: {w: 3, h: 2},
        backend: {
          kind: 'exec',
          routes: [
            {id: 'one', transport: 'http', method: 'GET', path: 'one', command: 'backend/echo.sh'},
            {id: 'two', transport: 'http', method: 'POST', path: 'two', command: 'backend/echo.sh'},
          ],
        },
      },
      index: 'export const createInstance = () => ({unmount() {}});\n',
      files: {'backend/echo.sh': '#!/bin/sh\n'},
    });

    await packPlugin(dir);

    const artifact = JSON.parse(readFileSync(join(dir, 'dist', 'mndw-artifact.json'), 'utf8')) as {
      staticBackends: string[];
    };
    const mode = statSync(join(dir, 'dist', 'backend', 'echo.sh')).mode.toString(8).slice(-3);

    expect(artifact.staticBackends).toEqual(['backend/echo.sh']);
    expect(mode).toBe('755');
  });

  it('bundles configured production source instead of the development source', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'configured-entry-widget'}),
      index: 'export const createInstance = () => ({unmount() {}, source: "DEV_ONLY_ENTRY"});\n',
      files: {
        'package.json': JSON.stringify({mndw: {productionEntry: 'src/index.prod.ts'}}),
        'src/index.prod.ts': 'export const createInstance = () => ({unmount() {}, source: "PRODUCTION_ENTRY"});\n',
      },
    });

    await packPlugin(dir);

    const bundle = readFileSync(join(dir, 'dist', 'index.js'), 'utf8');

    expect(bundle).toContain('PRODUCTION_ENTRY');
    expect(bundle).not.toContain('DEV_ONLY_ENTRY');
  });

  it('bundles development source when development packing is selected', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'development-entry-widget'}),
      index: 'export const createInstance = () => ({unmount() {}, source: "DEV_ONLY_ENTRY"});\n',
      files: {
        'package.json': JSON.stringify({mndw: {productionEntry: 'src/index.prod.ts'}}),
        'src/index.prod.ts': 'export const createInstance = () => ({unmount() {}, source: "PRODUCTION_ENTRY"});\n',
      },
    });

    await packPlugin(dir, {development: true});

    const bundle = readFileSync(join(dir, 'dist', 'index.js'), 'utf8');

    expect(bundle).toContain('DEV_ONLY_ENTRY');
    expect(bundle).not.toContain('PRODUCTION_ENTRY');
  });

  it('stages a module worker emitted alongside the main bundle', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'worker-widget'}),
      index: 'const worker = new Worker(new URL("./ticker.worker.ts", import.meta.url), {type: "module"});\n'
        + 'export const createInstance = () => ({unmount() { worker.terminate(); }});\n',
      files: {'src/ticker.worker.ts': 'self.postMessage("tick");\n'},
    });

    await packPlugin(dir);

    const jsFiles = readdirSync(join(dir, 'dist')).filter((file) => file.endsWith('.js'));
    const workerFile = jsFiles.find((file) => file !== 'index.js');
    const bundle = readFileSync(join(dir, 'dist', 'index.js'), 'utf8');

    expect(jsFiles).toHaveLength(2);
    expect(jsFiles).toContain('ticker.worker.js');
    expect(workerFile).toBeDefined();
    expect(bundle).toContain('./ticker.worker.js');
    expect(bundle).not.toContain('./ticker.worker.ts');
    expect(workerFile === undefined ? '' : readFileSync(join(dir, 'dist', workerFile), 'utf8')).toContain(
      'postMessage',
    );
  });

  it('stages a module worker imported from the SDK', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'sdk-worker-widget'}),
      index: 'import {Ticker} from "@mndw/sdk/ticker";\n'
        + 'const ticker = new Ticker();\n'
        + 'export const createInstance = () => ({unmount() { ticker.destroy(); }});\n',
    });

    await packPlugin(dir);

    const jsFiles = readdirSync(join(dir, 'dist')).filter((file) => file.endsWith('.js'));
    const bundle = readFileSync(join(dir, 'dist', 'index.js'), 'utf8');

    expect(jsFiles).toContain('ticker.worker.js');
    expect(bundle).toContain('./ticker.worker.js');
    expect(bundle).not.toContain('./ticker.worker.ts');
    expect(readFileSync(join(dir, 'dist', 'ticker.worker.js'), 'utf8')).toContain('postMessage');
  });

  it('bundles a svelte plugin and emits dist/index.css', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'svelte-widget'}),
      index: 'import App from "./App.svelte";\nexport const createInstance = () => ({unmount() {}, App});\n',
      files: {'src/App.svelte': '<style>h1{color:red}</style>\n<h1>hi</h1>\n'},
    });

    const result = await packPlugin(dir);

    expect(result.framework).toBe('svelte');
    expect(existsSync(join(dir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(dir, 'dist', 'index.css'))).toBe(true);
    expect(readFileSync(join(dir, 'dist', 'index.css'), 'utf8')).toContain('color');
  });

  it('bundles a vue plugin, keeps vue external, and emits dist/index.css', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'vue-widget'}),
      index: 'import {createApp} from "vue";\n'
        + 'import App from "./App.vue";\n'
        + 'export const createInstance = (el: HTMLElement) => {\n'
        + '  const app = createApp(App);\n'
        + '  app.mount(el);\n'
        + '  return {unmount() { app.unmount(); }};\n'
        + '};\n',
      files: {
        'src/App.vue': '<script setup lang="ts"></script>\n<template><h1>hi</h1></template>\n'
          + '<style scoped>h1{color:red}</style>\n',
      },
    });

    const result = await packPlugin(dir);

    expect(result.framework).toBe('vue');

    const js = readFileSync(join(result.outDir, 'index.js'), 'utf8');

    expect(js).toMatch(/from\s*["']vue["']/);
    expect(existsSync(join(result.outDir, 'index.css'))).toBe(true);
    expect(readFileSync(join(result.outDir, 'index.css'), 'utf8')).toMatch(/color:\s*red/);
  });

  it('AOT-compiles an angular plugin, keeps angular and d3 external, and emits index.css', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'ng-widget'}),
      files: {
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            experimentalDecorators: true,
            useDefineForClassFields: false,
            outDir: '.ngc-cache',
            rootDir: 'src',
          },
          angularCompilerOptions: {strictInjectionParameters: true},
          include: ['src/**/*.ts'],
        }),
        'src/app.component.ts': 'import {Component} from "@angular/core";\n'
          + '@Component({selector: "x-root", standalone: true, template: "<b></b>", styleUrls: ["./x.component.scss"]})\n'
          + 'export class AppComponent {}\n',
        'src/x.component.scss': '.a{.b{color:red}}',
        'src/index.ts': 'import "zone.js";\nimport "@angular/compiler";\n'
          + 'import {createApplication} from "@angular/platform-browser";\n'
          + 'import * as d3 from "d3";\n'
          + 'import {AppComponent} from "./app.component";\n'
          + 'export const createInstance = () => { void createApplication; void AppComponent; return {unmount() {}, d3, source: "DEV_ONLY_ANGULAR_ENTRY"}; };\n',
        'src/index.prod.ts': 'import "zone.js";\nimport "@angular/compiler";\n'
          + 'import {createApplication} from "@angular/platform-browser";\n'
          + 'import * as d3 from "d3";\n'
          + 'import {AppComponent} from "./app.component";\n'
          + 'export const createInstance = () => { void createApplication; void AppComponent; return {unmount() {}, d3, source: "PRODUCTION_ANGULAR_ENTRY"}; };\n',
        'package.json': JSON.stringify({mndw: {productionEntry: 'src/index.prod.ts'}}),
        'node_modules/d3/package.json': JSON.stringify({name: 'd3', type: 'module', module: 'index.js',
          types: 'index.d.ts'}),
        'node_modules/d3/index.d.ts': 'export const marker: string;\n',
        'node_modules/d3/index.js': 'export const marker = "d3 bundled";\n',
      },
    });

    const result = await packPlugin(dir);

    expect(result.framework).toBe('angular');

    const js = readFileSync(join(result.outDir, 'index.js'), 'utf8');

    expect(js).toMatch(/from\s*["']@angular\/core["']/);
    expect(js).toMatch(/(?:from|import)\s*["']zone\.js["']/);
    expect(js).toMatch(/from\s*["']d3["']/);
    expect(existsSync(join(result.outDir, 'index.css'))).toBe(true);
    expect(readFileSync(join(result.outDir, 'index.css'), 'utf8')).toMatch(/color:\s*red/);
  });

  it('stamps a version-1 mndw.lock.json alongside the bundle', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'locked-widget', version: '2.5.0'}),
      index: 'export const createInstance = () => ({unmount() {}});\n',
    });

    await packPlugin(dir);

    const lock = JSON.parse(readFileSync(join(dir, 'dist', 'mndw.lock.json'), 'utf8')) as {
      lockVersion: number;
      plugin: {name: string; version: string};
      framework: string;
      sdkVersion: string;
      sharedDependencies: Record<string, string>;
    };

    expect(lock.lockVersion).toBe(1);
    expect(lock.plugin).toEqual({name: 'locked-widget', version: '2.5.0'});
    expect(lock.framework).toBe('vanilla');
    expect(typeof lock.sdkVersion).toBe('string');
    expect(lock.sharedDependencies.rxjs).toBe('7.8.2');
  });

  it('packs a plugin that imports a shared dependency, keeping it external', async () => {
    scaffold(dir, {
      manifest: widgetManifest({name: 'rxjs-widget'}),
      index: 'import {of} from "rxjs";\nexport const createInstance = () => ({unmount() {}, stream: of(1)});\n',
    });

    await packPlugin(dir);

    const bundle = readFileSync(join(dir, 'dist', 'index.js'), 'utf8');

    expect(bundle).toContain('from "rxjs"');
  });

  it('writes the bundle at a nested manifest entry path', async () => {
    scaffold(dir, {
      manifest: widgetManifest({entry: 'assets/app.js'}),
      index: 'export const createInstance = () => ({unmount() {}});\n',
    });

    await packPlugin(dir);

    expect(existsSync(join(dir, 'dist', 'assets', 'app.js'))).toBe(true);
  });

  it('fails when src/index.ts is missing, leaving no dist directory', async () => {
    scaffold(dir, {manifest: widgetManifest()});

    await expect(packPlugin(dir)).rejects.toBeInstanceOf(CliError);
    expect(existsSync(join(dir, 'dist'))).toBe(false);
  });

  it('copies declared backend commands', async () => {
    scaffold(dir, {
      manifest: widgetManifest({
        name: 'backend-widget',
        backend: {
          kind: 'service',
          protocolVersion: 1,
          command: 'backend/server.sh',
          routes: [{id: 'status', transport: 'http', method: 'GET', path: 'status'}],
        },
      }),
      index: 'export const createInstance = () => ({unmount() {}});\n',
      files: {
        'backend/server.sh': '#!/bin/sh\necho server\n',
      },
    });

    await packPlugin(dir);

    expect(existsSync(join(dir, 'dist', 'backend', 'server.sh'))).toBe(true);
  });

  it('fails before writing output when a declared backend command is missing', async () => {
    scaffold(dir, {
      manifest: widgetManifest({
        backend: {kind: 'exec',
          routes: [{id: 'server', transport: 'http', method: 'GET', path: 'server', command: 'backend/server.sh'}]},
      }),
      index: 'export const createInstance = () => ({unmount() {}});\n',
    });

    await expect(packPlugin(dir)).rejects.toBeInstanceOf(CliError);
    expect(existsSync(join(dir, 'dist'))).toBe(false);
  });

  it.each([
    ['equals', (pluginDir: string) => pluginDir],
    ['is inside', (pluginDir: string) => join(pluginDir, 'src', 'output')],
    ['contains', (pluginDir: string) => resolve(pluginDir, '..')],
  ])('rejects an output directory that %s the plugin source', async (_case, outputDir) => {
    scaffold(dir, {
      manifest: widgetManifest(),
      index: 'export const createInstance = () => ({unmount() {}});\n',
    });

    await expect(packPlugin(dir, {outDir: outputDir(dir)})).rejects.toBeInstanceOf(CliError);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'index.ts'))).toBe(true);
  });

  it('keeps the existing output when promotion of a staged build fails', async () => {
    scaffold(dir, {
      manifest: widgetManifest(),
      index: 'export const createInstance = () => ({unmount() {}});\n',
    });
    await packPlugin(dir);
    writeFileSync(join(dir, 'dist', 'previous-output.txt'), 'preserve me');

    renameFailure.destination = join(dir, 'dist');
    renameFailure.remaining = 1;

    await expect(packPlugin(dir)).rejects.toThrow('simulated promotion failure');
    expect(readFileSync(join(dir, 'dist', 'previous-output.txt'), 'utf8')).toBe('preserve me');
  });
});

describe('packExamplePlugins', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  let outDir: string;
  let names: string[];

  beforeEach(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'mndw-example-plugins-'));
    names = await packExamplePlugins({outDir, sourceDir: join(repoRoot, 'plugins/builtin')});
  }, 60_000);

  afterEach(() => {
    rmSync(outDir, {recursive: true, force: true});
  });

  function bundle(name: string): string {
    return readFileSync(join(outDir, name, 'index.js'), 'utf8');
  }

  it('builds every example plugin into one output destination', () => {
    expect(names).toEqual([
      'backend-echo',
      'clients-widget',
      'clock-widget',
      'demo-page',
      'device-info-widget',
      'device-traffic-widget',
      'dns-lookup-widget',
      'mws-page',
      'ping-widget',
      'system-log-page',
      'terminal-page',
      'tx-rx-chart-widget',
    ]);

    for (const name of names) {
      expect(existsSync(join(outDir, name, 'index.js'))).toBe(true);
      expect(existsSync(join(outDir, name, 'manifest.json'))).toBe(true);
    }

    const scriptMode = statSync(join(outDir, 'backend-echo', 'backend', 'echo.cgi')).mode;

    const hasExecutableBit = [0o100, 0o010, 0o001].some((bit) => Math.floor(scriptMode / bit) % 2 === 1);

    expect(hasExecutableBit).toBe(true);
  });

  it('preserves manifests, emitted CSS, bundled dependencies, and shared externals', () => {
    for (const name of names) {
      const manifest = JSON.parse(readFileSync(join(outDir, name, 'manifest.json'), 'utf8'));

      expect(() => validateManifest(manifest)).not.toThrow();
    }

    expect(existsSync(join(outDir, 'device-traffic-widget', 'index.css'))).toBe(true);

    const widgetBundle = bundle('device-traffic-widget');

    expect(widgetBundle).toMatch(/from\s*["']rxjs["']/);
    expect(widgetBundle).not.toMatch(/["']@rci-tools\/core["']/);
    expect(widgetBundle).toMatch(/from\s*["']@mndw\/ui["']/);
    expect(widgetBundle).not.toMatch(/from\s*["']d3["']/);
    expect(widgetBundle).not.toContain('d3-selection');

    const svelteBundle = bundle('device-traffic-widget');

    expect(svelteBundle).not.toMatch(/from\s*["']svelte["']/);
    expect(svelteBundle).toContain('svelte');
  });
});

describe('packExamplePlugins build pre-pass', () => {
  it('uses development entries when development packing is selected', async () => {
    const src = mkdtempSync(join(tmpdir(), 'mndw-dev-examples-'));
    const plugin = join(src, 'dev-entry-widget');

    mkdirSync(plugin, {recursive: true});

    scaffold(plugin, {
      manifest: widgetManifest({name: 'dev-entry-widget'}),
      index: 'export const createInstance = () => ({unmount() {}, source: "DEV_ONLY_ENTRY"});\n',
      files: {
        'package.json': JSON.stringify({mndw: {productionEntry: 'src/index.prod.ts'}}),
        'src/index.prod.ts': 'export const createInstance = () => ({unmount() {}, source: "PRODUCTION_ENTRY"});\n',
      },
    });

    const outDir = join(src, 'dist');

    await packExamplePlugins({sourceDir: src, outDir, development: true});

    const bundle = readFileSync(join(outDir, 'dev-entry-widget', 'index.js'), 'utf8');

    expect(bundle).toContain('DEV_ONLY_ENTRY');
    expect(bundle).not.toContain('PRODUCTION_ENTRY');

    rmSync(src, {recursive: true, force: true});
  });

  it('runs each example plugin build script before packing', async () => {
    const src = mkdtempSync(join(tmpdir(), 'mndw-examples-'));
    const plugin = join(src, 'built-widget');

    mkdirSync(join(plugin, 'src'), {recursive: true});
    writeFileSync(join(plugin, 'src', 'index.ts'), 'export function createInstance(){return {unmount(){}}}');
    writeFileSync(
      join(plugin, 'manifest.json'),
      JSON.stringify({
        manifestVersion: 3,
        name: 'built-widget',
        version: '0.1.0',
        type: 'widget',
        label: 'Built',
        entry: 'index.js',
        size: {w: 2, h: 2},
        backend: {
          kind: 'service',
          protocolVersion: 1,
          command: 'backend/marker.bin',
          routes: [{id: 'status', transport: 'http', method: 'GET', path: 'status'}],
        },
      }),
    );
    writeFileSync(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: '@mndw/example-built-widget',
        version: '0.1.0',
        private: true,
        scripts: {
          build:
            'node -e "require(\'fs\').mkdirSync(\'backend\',{recursive:true});require(\'fs\').writeFileSync(\'backend/marker.bin\',\'ok\')"',
        },
      }),
    );

    const outDir = join(src, 'dist');
    const names = await packExamplePlugins({outDir, sourceDir: src});

    expect(names).toEqual(['built-widget']);
    expect(readFileSync(join(outDir, 'built-widget', 'backend', 'marker.bin'), 'utf8')).toBe('ok');

    rmSync(src, {recursive: true, force: true});
  });
});
