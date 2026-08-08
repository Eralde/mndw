import {chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

import {ManifestValidationError, validateManifest} from '@mndw/sdk';

import {CliError} from './errors.js';
import {type PluginFramework} from './framework.js';
import {resolveSdkVersion} from './lock.js';

/** Repo root, relative to this module (`src/` → `cli/` → `tooling/` → root). */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
/** On-disk manifest schema, referenced by in-repo scaffolds for editor validation. */
const SDK_SCHEMA_PATH = resolve(REPO_ROOT, 'frontend', 'sdk', 'manifest.schema.json');
/** Renderable template roots, one per framework plus the shared backend starter. */
const TEMPLATES_DIR = resolve(import.meta.dirname, '..', 'templates');
/** This CLI's own manifest, the single source of generated dependency version ranges. */
const CLI_PACKAGE_JSON = resolve(import.meta.dirname, '..', 'package.json');

export interface CreateOptions {
  readonly name: string;
  /** Defaults to `widget`. */
  readonly type?: 'widget' | 'page';
  /** Defaults to `vanilla`. */
  readonly framework?: PluginFramework;
  /** Resolved absolute destination directory. */
  readonly outDir: string;
  /** Human label; defaults to a title-cased `name`. */
  readonly label?: string;
  /** Page route (page type only); defaults to `/<name>`. */
  readonly route?: string;
  /** Backend starter runtime. Only `sh` is supported; omit for no backend. */
  readonly backend?: 'sh';
}

interface NormalizedOptions {
  readonly name: string;
  readonly type: 'widget' | 'page';
  readonly framework: PluginFramework;
  readonly outDir: string;
  readonly label: string;
  readonly route: string;
  readonly backend?: 'sh';
}

export interface GeneratedFile {
  /** POSIX path relative to the plugin directory. */
  readonly path: string;
  readonly contents: string;
  /** true → written with the executable bit set (backend commands). */
  readonly executable?: boolean;
}

export interface CreatePlan {
  readonly name: string;
  readonly type: 'widget' | 'page';
  readonly framework: PluginFramework;
  readonly label: string;
  readonly route: string;
  readonly outDir: string;
  readonly files: readonly GeneratedFile[];
}

/** Title-cases a hyphenated plugin name (`my-cool-widget` → `My Cool Widget`). */
export function toLabel(name: string): string {
  return name
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function normalize(options: CreateOptions): NormalizedOptions {
  const name = options.name;

  return {
    name,
    type: options.type ?? 'widget',
    framework: options.framework ?? 'vanilla',
    outDir: options.outDir,
    label: options.label ?? toLabel(name),
    route: options.route ?? `/${name}`,
    backend: options.backend,
  };
}

/** True when `outDir` lives inside this workspace, where `workspace:*` deps and the on-disk schema resolve. */
function isInsideRepo(outDir: string): boolean {
  const rel = relative(REPO_ROOT, resolve(outDir));

  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** POSIX-relative `$schema` reference: on-disk path in-repo, installed-package path elsewhere. */
function schemaReference(outDir: string): string {
  if (!isInsideRepo(outDir)) {
    return './node_modules/@mndw/sdk/manifest.schema.json';
  }

  const relativePath = relative(resolve(outDir), SDK_SCHEMA_PATH);

  return relativePath.split(/[/\\]/).join('/');
}

/**
 * Builds the v3 manifest object for a scaffold: grid-unit `size` for widgets,
 * `/<name>` route for pages, and (for `--backend sh`) one relative exec command route.
 */
export function buildManifest(options: CreateOptions): Record<string, unknown> {
  const normalized = normalize(options);

  const manifest: Record<string, unknown> = {
    $schema: schemaReference(normalized.outDir),
    manifestVersion: 3,
    name: normalized.name,
    version: '0.1.0',
    type: normalized.type,
    label: normalized.label,
    entry: 'index.js',
  };

  if (normalized.type === 'widget') {
    manifest.size = {w: 4, h: 3, minW: 2, minH: 2};
  } else {
    manifest.route = normalized.route;
  }

  if (normalized.backend !== undefined) {
    manifest.backend = {
      kind: 'exec',
      routes: [{id: 'hello', transport: 'http', method: 'GET', path: 'hello', command: 'backend/main.sh'}],
    };
  }

  return manifest;
}

interface CliMetadata {
  readonly version: string;
  readonly svelteRange: string;
  readonly vueRange: string;
  readonly angular: Record<string, string>;
}

function readCliMetadata(): CliMetadata {
  const parsed = JSON.parse(readFileSync(CLI_PACKAGE_JSON, 'utf8')) as {
    version?: string;
    dependencies?: Record<string, string>;
  };

  const dependencies = parsed.dependencies ?? {};

  return {
    version: parsed.version ?? '0.0.0',
    svelteRange: dependencies.svelte ?? '^5.0.0',
    vueRange: dependencies.vue ?? '^3.5.39',
    angular: {
      '@angular/core': dependencies['@angular/core'] ?? '^21.2.18',
      '@angular/common': dependencies['@angular/common'] ?? '^21.2.18',
      '@angular/platform-browser': dependencies['@angular/platform-browser'] ?? '^21.2.18',
      '@angular/compiler': dependencies['@angular/compiler'] ?? '^21.2.18',
      'zone.js': dependencies['zone.js'] ?? '^0.15.1',
      'typescript': dependencies.typescript ?? '^5.7.0',
    },
  };
}

/** Builds the scaffold's `package.json`: everything a plugin needs is build/type-only, so it all
 * lives in `devDependencies` (spec Decision 10 — the packed artifact never ships these). */
function buildPackageJson(normalized: NormalizedOptions): Record<string, unknown> {
  const inside = isInsideRepo(normalized.outDir);
  const cli = readCliMetadata();
  const sdkRange = inside ? 'workspace:*' : `^${resolveSdkVersion()}`;

  const devDependencies: Record<string, string> = {
    '@mndw/sdk': sdkRange,
    '@mndw/cli': inside ? 'workspace:*' : `^${cli.version}`,
  };

  if (normalized.framework === 'svelte') {
    devDependencies.svelte = cli.svelteRange;
  } else if (normalized.framework === 'vue') {
    devDependencies.vue = cli.vueRange;
  } else if (normalized.framework === 'angular') {
    Object.assign(devDependencies, cli.angular);
  }

  return {
    name: `@mndw/plugin-${normalized.name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    devDependencies,
  };
}

function renderPlaceholders(contents: string, normalized: NormalizedOptions): string {
  return contents
    .replaceAll('__MNDW_LABEL__', normalized.label)
    .replaceAll('__MNDW_NAME__', normalized.name);
}

/** Collects a template directory's files as plugin-relative POSIX paths. */
function walkTemplate(dir: string, prefix: string): {rel: string; abs: string}[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const abs = join(dir, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    return entry.isDirectory() ? walkTemplate(abs, rel) : [{rel, abs}];
  });
}

function renderTemplateDir(framework: PluginFramework, normalized: NormalizedOptions): GeneratedFile[] {
  return walkTemplate(join(TEMPLATES_DIR, framework), '').map(({rel, abs}) => ({
    path: rel,
    contents: renderPlaceholders(readFileSync(abs, 'utf8'), normalized),
  }));
}

function renderBackendFile(normalized: NormalizedOptions): GeneratedFile {
  const source = readFileSync(join(TEMPLATES_DIR, 'backend', 'main.sh'), 'utf8');

  return {path: 'backend/main.sh', contents: renderPlaceholders(source, normalized), executable: true};
}

/**
 * Produces the full in-memory file plan for a new plugin — manifest, package, framework source, and an
 * optional backend starter — without touching the filesystem, so it is fully testable in isolation.
 */
export function planCreate(options: CreateOptions): CreatePlan {
  const normalized = normalize(options);

  const files: GeneratedFile[] = [
    {path: 'manifest.json', contents: `${JSON.stringify(buildManifest(options), null, 2)}\n`},
    {path: 'package.json', contents: `${JSON.stringify(buildPackageJson(normalized), null, 2)}\n`},
    ...renderTemplateDir(normalized.framework, normalized),
  ];

  if (normalized.backend !== undefined) {
    files.push(renderBackendFile(normalized));
  }

  return {
    name: normalized.name,
    type: normalized.type,
    framework: normalized.framework,
    label: normalized.label,
    route: normalized.route,
    outDir: normalized.outDir,
    files,
  };
}

export interface CreateResult {
  readonly outDir: string;
  readonly plan: CreatePlan;
}

/** Rejects unsupported enum flags before any template lookup or filesystem write. */
function assertSupportedOptions(options: CreateOptions): void {
  const type = options.type ?? 'widget';

  if (type !== 'widget' && type !== 'page') {
    throw new CliError(`Invalid --type "${type}": expected "widget" or "page"`);
  }

  const framework = options.framework ?? 'vanilla';

  if (framework !== 'vanilla' && framework !== 'svelte' && framework !== 'vue' && framework !== 'angular') {
    throw new CliError(
      `Invalid --framework "${framework}": expected "vanilla", "svelte", "vue", or "angular"`,
    );
  }

  if (options.backend !== undefined && options.backend !== 'sh') {
    throw new CliError(`Invalid --backend "${String(options.backend)}": only "sh" is supported`);
  }
}

/** Creates `dir` and any missing ancestors, recording each newly created directory for rollback. */
function ensureDir(dir: string, created: string[]): void {
  if (existsSync(dir)) {
    return;
  }

  ensureDir(dirname(dir), created);
  mkdirSync(dir);
  created.push(dir);
}

function writePlan(outDir: string, plan: CreatePlan): void {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];

  try {
    ensureDir(outDir, createdDirs);

    for (const file of plan.files) {
      const dest = join(outDir, file.path);

      ensureDir(dirname(dest), createdDirs);
      writeFileSync(dest, file.contents);
      createdFiles.push(dest);

      if (file.executable === true) {
        chmodSync(dest, 0o755);
      }
    }
  } catch (error) {
    for (const file of createdFiles.reverse()) {
      rmSync(file, {force: true});
    }

    for (const dir of createdDirs.reverse()) {
      rmSync(dir, {recursive: true, force: true});
    }

    throw error;
  }
}

/**
 * Scaffolds a new plugin on disk. Validates flags and the generated manifest (via the SDK schema — the
 * single authority for name/route rules) and refuses a non-empty destination, all before writing. Any
 * write failure rolls back only the files and directories this invocation created.
 */
export function createPlugin(options: CreateOptions): CreateResult {
  assertSupportedOptions(options);

  const plan = planCreate(options);
  const outDir = resolve(options.outDir);
  const manifestFile = plan.files.find((file) => file.path === 'manifest.json');

  try {
    validateManifest(JSON.parse(manifestFile === undefined ? '{}' : manifestFile.contents));
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      throw new CliError(`Cannot create plugin "${options.name}": ${error.message}`);
    }

    throw error;
  }

  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new CliError(`Refusing to write: ${outDir} already exists and is not empty`);
  }

  writePlan(outDir, plan);

  return {outDir, plan};
}
