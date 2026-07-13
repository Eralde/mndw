import {accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
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

  it('builds a v2 widget manifest with a grid-unit size', () => {
    const manifest = buildManifest(options({type: 'widget'}));

    expect(manifest.manifestVersion).toBe(2);
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

  it('adds a v2-relative backend script and endpoint for --backend sh', () => {
    const manifest = buildManifest(options({type: 'widget', backend: 'sh'}));
    const backend = manifest.backend as {
      scripts: {id: string; source: string; runtime: string}[];
      endpoints: {id: string; method: string; path: string; scriptId: string}[];
    };

    expect(backend.scripts).toEqual([{id: 'main', source: 'backend/main.sh', runtime: 'sh'}]);
    // Endpoint path is relative — no leading slash, no /api/plugins prefix (daemon namespaces it).
    expect(backend.endpoints[0].path).toBe('hello');
    expect(backend.endpoints[0].path.startsWith('/')).toBe(false);
    expect(backend.endpoints[0].scriptId).toBe('main');
    // Script source is a safe relative path.
    expect(backend.scripts[0].source.startsWith('/')).toBe(false);
    expect(backend.scripts[0].source.includes('..')).toBe(false);
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
      dependencies?: Record<string, string>;
    };

    expect(manifest.name).toBe('my-widget');
    expect(manifest.manifestVersion).toBe(2);
    expect(pkg.dependencies?.['@mndw/sdk']).toBeDefined();
  });

  it('renders a svelte plugin with an App.svelte component', () => {
    const plan = planCreate(options({name: 'sv', framework: 'svelte', type: 'widget'}));

    const app = fileContents(plan, 'src/App.svelte');

    expect(app).toContain('@mndw/sdk');
    expect(app).toContain('var(--mndw-');
    expect(app).not.toContain('__MNDW_');
    expect(fileContents(plan, 'src/index.ts')).toContain('App.svelte');
  });

  it('adds an executable backend script for --backend sh', () => {
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

    expect(insidePkg.dependencies['@mndw/sdk']).toBe('workspace:*');
    expect(insidePkg.dependencies.svelte).toBeDefined();
    expect(insidePkg.devDependencies['@mndw/cli']).toBe('workspace:*');

    const outsidePlan = planCreate({name: 'outside-plugin', outDir, framework: 'vanilla', type: 'widget'});
    const outsidePkg = JSON.parse(fileContents(outsidePlan, 'package.json')) as {
      dependencies: Record<string, string>;
    };

    expect(outsidePkg.dependencies['@mndw/sdk']).toMatch(/^\^/);
    expect(outsidePkg.dependencies.svelte).toBeUndefined();
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

  it('refuses a non-empty destination and leaves pre-existing files untouched', () => {
    const occupied = join(root, 'occupied');

    mkdirSync(occupied, {recursive: true});
    writeFileSync(join(occupied, 'keep.txt'), 'keep');

    expect(() => createPlugin({name: 'widget', outDir: occupied, type: 'widget'})).toThrow(/not empty/);
    expect(readFileSync(join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(occupied, 'manifest.json'))).toBe(false);
  });

  it('writes an executable backend script and a plain manifest', () => {
    const outDir = join(root, 'be');

    createPlugin({name: 'be-widget', outDir, type: 'widget', backend: 'sh'});

    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(outDir, 'backend', 'main.sh'))).toBe(true);
    // Executable bit set — accessSync throws if the file is not executable.
    expect(() => accessSync(join(outDir, 'backend', 'main.sh'), constants.X_OK)).not.toThrow();
  });

  const combos: {framework: 'vanilla' | 'svelte'; type: 'widget' | 'page'}[] = [
    {framework: 'vanilla', type: 'widget'},
    {framework: 'vanilla', type: 'page'},
    {framework: 'svelte', type: 'widget'},
    {framework: 'svelte', type: 'page'},
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
      expect(existsSync(join(outDir, 'dist', 'index.css'))).toBe(true);

      // zip
      const zipped = await zipPlugin(outDir);

      expect(existsSync(zipped.outputPath)).toBe(true);
    });
  }
});
