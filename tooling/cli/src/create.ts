import {type ChildProcess} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import crossSpawn from 'cross-spawn';

import {ManifestValidationError, validateManifest} from '@mndw/sdk-internal';
import {sharedDependencyVersions} from '@mndw/sdk-internal/shared-dependencies';

import {CliError} from './errors.js';
import {type PluginFramework} from './framework.js';
import {cliPackageRoot} from './cli-package-root.js';
import {resolveSdkVersion} from './lock.js';
import {detectPackageManager} from './package-manager.js';
import {promptFramework} from './prompt-framework.js';

/** Repo root, relative to this module (`src/` → `cli/` → `tooling/` → root). */
const CLI_PACKAGE_ROOT = cliPackageRoot();
const REPO_ROOT = resolve(CLI_PACKAGE_ROOT, '..', '..');
/** On-disk manifest schema, referenced by in-repo scaffolds for editor validation. */
const SDK_SCHEMA_PATH = resolve(REPO_ROOT, 'frontend', 'sdk', 'manifest.schema.json');
/** Renderable template roots, one per framework plus the shared backend starter. */
const TEMPLATES_DIR = resolve(CLI_PACKAGE_ROOT, 'templates');
/** This CLI's own manifest, the single source of generated dependency version ranges. */
const CLI_PACKAGE_JSON = resolve(CLI_PACKAGE_ROOT, 'package.json');

export interface CreateOptions {
  readonly name: string;
  /** Defaults to `widget`. */
  readonly type?: 'widget' | 'page';
  /** Defaults to `svelte`. */
  readonly framework?: PluginFramework;
  /** Resolved absolute destination directory. */
  readonly outDir: string;
  /** Human label; defaults to a title-cased `name`. */
  readonly label?: string;
  /** Page route (page type only); defaults to `/<name>`. */
  readonly route?: string;
  /** Backend starter runtime. Omit for no backend. */
  readonly backend?: 'sh' | 'go';
}

interface NormalizedOptions {
  readonly name: string;
  readonly type: 'widget' | 'page';
  readonly framework: PluginFramework;
  readonly outDir: string;
  readonly label: string;
  readonly route: string;
  readonly backend?: 'sh' | 'go';
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
    framework: options.framework ?? 'svelte',
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
 * Builds the manifest object for a scaffold: grid-unit `size` for widgets,
 * `/<name>` route for pages, and fixed exec/service routes for the supported backend starters.
 */
export function buildManifest(options: CreateOptions): Record<string, unknown> {
  const normalized = normalize(options);

  const manifest: Record<string, unknown> = {
    $schema: schemaReference(normalized.outDir),
    manifestVersion: 1,
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

  if (normalized.backend !== 'go') {
    manifest.i18n = {
      defaultLocale: 'en',
      locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'},
    };
  }

  if (normalized.backend === 'go') {
    manifest.backend = {
      kind: 'service',
      protocolVersion: 1,
      command: `backend/${normalized.name}d`,
      routes: [{id: 'hello', transport: 'http', method: 'GET', path: 'hello'}],
    };
  } else if (normalized.backend === 'sh') {
    manifest.backend = {
      kind: 'exec',
      routes: [{id: 'hello', transport: 'http', method: 'GET', path: 'hello', command: 'backend/main.sh'}],
    };
  }

  return manifest;
}

interface CliMetadata {
  readonly version: string;
  readonly uiRange: string;
  readonly uiWrapperRanges: Record<'svelte' | 'vue' | 'angular', string>;
  readonly svelteRange: string;
  readonly svelteVitePluginRange: string;
  readonly vueRange: string;
  readonly vueVitePluginRange: string;
  readonly angular: Record<string, string>;
  readonly viteRange: string;
  readonly vitestRange: string;
  readonly happyDomRange: string;
}

interface CliPackageMetadata {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const UI_WORKSPACE_PACKAGES = {
  '@mndw/ui': 'frontend/ui',
  '@mndw/ui-svelte': 'frontend/ui-svelte',
  '@mndw/ui-vue': 'frontend/ui-vue',
  '@mndw/ui-angular': 'frontend/ui-angular',
} as const;

function packageRange(
  name: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): string {
  const range = dependencies[name] ?? devDependencies[name];

  if (range === undefined) {
    throw new CliError(`CLI package is missing dependency range for ${name}`);
  }

  return range;
}

function publishedWorkspaceRange(name: keyof typeof UI_WORKSPACE_PACKAGES, range: string): string {
  if (!range.startsWith('workspace:')) {
    return range;
  }

  const protocolRange = range.slice('workspace:'.length);

  if (protocolRange !== '*' && protocolRange !== '^' && protocolRange !== '~') {
    throw new CliError(`CLI package has unsupported workspace range for ${name}: ${range}`);
  }

  const packageJsonPath = resolve(REPO_ROOT, UI_WORKSPACE_PACKAGES[name], 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {version?: string};
  const version = packageJson.version;

  if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new CliError(`Workspace package ${name} must declare an exact semver version`);
  }

  if (protocolRange === '*') {
    return version;
  }

  return `${protocolRange}${version}`;
}

function caretRange(name: string, value: string | undefined): string {
  if (value === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new CliError(`CLI package devDependency ${name} must be an exact semver version`);
  }

  return `^${value}`;
}

export function readCliMetadata(metadata?: CliPackageMetadata): CliMetadata {
  const parsed = metadata ?? JSON.parse(readFileSync(CLI_PACKAGE_JSON, 'utf8')) as CliPackageMetadata;

  const dependencies = parsed.dependencies ?? {};
  const devDependencies = parsed.devDependencies ?? {};
  const svelteRange = packageRange('svelte', dependencies, devDependencies);
  const uiRange = publishedWorkspaceRange('@mndw/ui', packageRange('@mndw/ui', dependencies, devDependencies));
  const uiWrapperRanges = {
    svelte: publishedWorkspaceRange(
      '@mndw/ui-svelte',
      packageRange('@mndw/ui-svelte', dependencies, devDependencies),
    ),
    vue: publishedWorkspaceRange('@mndw/ui-vue', packageRange('@mndw/ui-vue', dependencies, devDependencies)),
    angular: publishedWorkspaceRange(
      '@mndw/ui-angular',
      packageRange('@mndw/ui-angular', dependencies, devDependencies),
    ),
  };

  return {
    version: parsed.version ?? '0.0.0',
    uiRange,
    uiWrapperRanges,
    svelteRange,
    svelteVitePluginRange: packageRange('@sveltejs/vite-plugin-svelte', dependencies, devDependencies),
    vueRange: packageRange('vue', dependencies, devDependencies),
    vueVitePluginRange: packageRange('@vitejs/plugin-vue', dependencies, devDependencies),
    angular: {
      '@angular/core': packageRange('@angular/core', dependencies, devDependencies),
      '@angular/common': packageRange('@angular/common', dependencies, devDependencies),
      '@angular/platform-browser': packageRange('@angular/platform-browser', dependencies, devDependencies),
      '@angular/compiler': packageRange('@angular/compiler', dependencies, devDependencies),
      'zone.js': packageRange('zone.js', dependencies, devDependencies),
      'typescript': packageRange('typescript', dependencies, devDependencies),
    },
    viteRange: packageRange('vite', dependencies, devDependencies),
    vitestRange: caretRange('vitest', packageRange('vitest', dependencies, devDependencies)),
    happyDomRange: caretRange('happy-dom', packageRange('happy-dom', dependencies, devDependencies)),
  };
}

/** Builds the scaffold's `package.json`: everything a plugin needs is build/type-only, so it all
 * lives in `devDependencies` (spec Decision 10 — the packed artifact never ships these). */
function buildPackageJson(normalized: NormalizedOptions): Record<string, unknown> {
  const inside = isInsideRepo(normalized.outDir);
  const cli = readCliMetadata();
  const sharedVersions = sharedDependencyVersions();
  const sdkRange = inside ? 'workspace:*' : `^${resolveSdkVersion()}`;

  const devDependencies: Record<string, string> = {
    '@mndw/sdk': sdkRange,
    '@mndw/cli': inside ? 'workspace:*' : `^${cli.version}`,
    '@rci-tools/core': caretRange('@rci-tools/core', sharedVersions['@rci-tools/core']),
    'happy-dom': cli.happyDomRange,
    'rxjs': caretRange('rxjs', sharedVersions.rxjs),
    'vitest': cli.vitestRange,
  };

  const dependencies: Record<string, string> = {};

  if (normalized.framework === 'svelte') {
    dependencies['@mndw/ui'] = inside ? 'workspace:*' : cli.uiRange;
    dependencies['@mndw/ui-svelte'] = inside ? 'workspace:*' : cli.uiWrapperRanges.svelte;
    devDependencies.svelte = cli.svelteRange;
    devDependencies['@sveltejs/vite-plugin-svelte'] = cli.svelteVitePluginRange;
    devDependencies.vite = cli.viteRange;
  } else if (normalized.framework === 'vue') {
    dependencies['@mndw/ui'] = inside ? 'workspace:*' : cli.uiRange;
    dependencies['@mndw/ui-vue'] = inside ? 'workspace:*' : cli.uiWrapperRanges.vue;
    devDependencies.vue = cli.vueRange;
    devDependencies['@vitejs/plugin-vue'] = cli.vueVitePluginRange;
    devDependencies.vite = cli.viteRange;
  } else if (normalized.framework === 'angular') {
    dependencies['@mndw/ui'] = inside ? 'workspace:*' : cli.uiRange;
    dependencies['@mndw/ui-angular'] = inside ? 'workspace:*' : cli.uiWrapperRanges.angular;
    Object.assign(devDependencies, cli.angular);
  }

  return {
    name: `@mndw/plugin-${normalized.name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {test: 'vitest run'},
    dependencies,
    devDependencies,
  };
}

function renderPlaceholders(contents: string, normalized: NormalizedOptions): string {
  return contents
    .replaceAll('__MNDW_LABEL__', normalized.label)
    .replaceAll('__MNDW_NAME__', normalized.name)
    .replaceAll('__MNDW_ROUTE__', normalized.route)
    .replaceAll('__MNDW_SCHEMA__', schemaReference(normalized.outDir));
}

/** Collects a template directory's files as plugin-relative POSIX paths. */
function walkTemplate(dir: string, prefix: string): {rel: string; abs: string}[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const abs = join(dir, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    return entry.isDirectory() ? walkTemplate(abs, rel) : [{rel, abs}];
  });
}

function templateOutputPath(path: string): string {
  return path
    .split('/')
    .map((part) => part === 'gitignore' ? '.gitignore' : part)
    .join('/');
}

function renderTemplateDir(framework: PluginFramework, normalized: NormalizedOptions): GeneratedFile[] {
  return walkTemplate(join(TEMPLATES_DIR, framework), '').map(({rel, abs}) => ({
    path: renderPlaceholders(templateOutputPath(rel), normalized),
    contents: renderPlaceholders(readFileSync(abs, 'utf8'), normalized),
  }));
}

function renderGoTemplate(normalized: NormalizedOptions): GeneratedFile[] {
  const generatedDevDependencies = buildPackageJson(normalized).devDependencies as Record<string, string>;

  return walkTemplate(join(TEMPLATES_DIR, 'go'), '').map(({rel, abs}) => {
    let contents = renderPlaceholders(readFileSync(abs, 'utf8'), normalized);

    if (rel === 'package.json') {
      const packageJson = JSON.parse(contents) as {devDependencies: Record<string, string>};

      packageJson.devDependencies['@mndw/cli'] = generatedDevDependencies['@mndw/cli'];
      packageJson.devDependencies['@mndw/sdk'] = generatedDevDependencies['@mndw/sdk'];
      contents = `${JSON.stringify(packageJson, null, 2)}\n`;
    }

    return {path: renderPlaceholders(templateOutputPath(rel), normalized), contents};
  });
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

  const files: GeneratedFile[] = normalized.backend === 'go'
    ? renderGoTemplate(normalized)
    : [
      {path: 'manifest.json', contents: `${JSON.stringify(buildManifest(options), null, 2)}\n`},
      {path: 'package.json', contents: `${JSON.stringify(buildPackageJson(normalized), null, 2)}\n`},
      ...renderTemplateDir(normalized.framework, normalized),
    ];

  if (normalized.backend === 'sh') {
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

  const framework = options.framework ?? 'svelte';

  if (framework !== 'vanilla' && framework !== 'svelte' && framework !== 'vue' && framework !== 'angular') {
    throw new CliError(
      `Invalid --framework "${framework}": expected "vanilla", "svelte", "vue", or "angular"`,
    );
  }

  if (options.backend !== undefined && options.backend !== 'sh' && options.backend !== 'go') {
    throw new CliError(`Invalid --backend "${String(options.backend)}": expected "sh" or "go"`);
  }

  if (options.backend === 'go') {
    if (framework !== 'vanilla' || type !== 'page') {
      throw new CliError('--backend go requires --framework vanilla and --type page');
    }
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

export interface CreateCommandOptions extends CreateOptions {
  /** Skip dependency installation outside the repository. */
  readonly noInstall?: boolean;
}

export interface CreateDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream & {readonly isTTY?: boolean};
  readonly stdout?: NodeJS.WritableStream & {readonly isTTY?: boolean};
  readonly spawn?: (command: string, args: string[], options: {cwd: string; stdio: 'inherit'}) => ChildProcess;
}

function runInstall(
  command: string,
  cwd: string,
  spawn: NonNullable<CreateDependencies['spawn']>,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;

    try {
      child = spawn(command, ['install'], {cwd, stdio: 'inherit'});
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : '';

      rejectPromise(new CliError(`Failed to run ${command} install${detail}`));

      return;
    }

    child.once('error', (error) => {
      rejectPromise(new CliError(`Failed to run ${command} install: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();

        return;
      }

      const reason = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;

      rejectPromise(new CliError(`${command} install failed with ${reason}`));
    });
  });
}

/** Scaffolds a plugin, prompts for framework when interactive, and installs outside-repository dependencies. */
export async function create(
  options: CreateCommandOptions,
  dependencies: CreateDependencies = {},
): Promise<CreateResult> {
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  let framework = options.framework;

  if (framework === undefined) {
    framework = stdin.isTTY === true && stdout.isTTY === true
      ? await promptFramework({input: stdin, output: stdout})
      : 'svelte';
  }

  const result = createPlugin({...options, framework});

  if (isInsideRepo(result.outDir)) {
    stdout.write('Run pnpm install from the repository root.\n');

    return result;
  }

  if (options.noInstall !== true) {
    const command = detectPackageManager({env: dependencies.env, cwd: dependencies.cwd});
    const spawn = dependencies.spawn ?? crossSpawn;

    await runInstall(command, result.outDir, spawn);
  }

  return result;
}
