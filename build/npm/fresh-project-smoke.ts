import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import ts from 'typescript';
import {MNDWD_PLATFORMS, mndwdPlatformFor} from '../../tooling/cli/src/mndwd-platforms.js';
import {containsUncompiledSvelteRuneCall} from '../../tooling/cli/src/dev-server/svelte-rune-check.js';
import {PRODUCT_TARGETS} from '../targets.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export type TarballMap = Readonly<Record<string, string>>;

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  mndw?: {backend?: {binaryName?: unknown}};
  [key: string]: unknown;
}

interface FetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export interface ImportedModule {
  readonly url: string;
  readonly body: string;
}

interface SmokeRow {
  readonly step: string;
  readonly status: 'pass' | 'fail' | 'skipped';
  readonly detail: string;
}

const OTHER_PACKAGE_DIRS: Readonly<Record<string, string>> = {
  '@mndw/palette-core': 'tooling/palette-core',
  '@mndw/sdk': 'frontend/sdk',
  '@mndw/ui': 'frontend/ui',
  '@mndw/ui-svelte': 'frontend/ui-svelte',
  '@mndw/ui-vue': 'frontend/ui-vue',
  '@mndw/ui-angular': 'frontend/ui-angular',
  '@mndw/cli': 'tooling/cli',
};

const readJson = async (path: string): Promise<PackageJson> => {
  return JSON.parse(await readFile(path, 'utf8')) as PackageJson;
};

const fileSpec = (path: string): string => `file:${resolve(path)}`;

export function buildPackageManagerManifest(
  packageManager: PackageManager,
  tarballs: TarballMap,
  directPackages: readonly string[],
): Record<string, unknown> {
  const dependencies = Object.fromEntries(directPackages.map((name) => {
    const tarball = tarballs[name];

    if (tarball === undefined) {
      throw new Error(`No local npm tarball found for ${name}`);
    }

    return [name, fileSpec(tarball)];
  }));
  const resolutions = Object.fromEntries(Object.entries(tarballs).map(([name, tarball]) => [name, fileSpec(tarball)]));
  const manifest: Record<string, unknown> = {
    name: 'mndw-npm-smoke',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies,
  };

  if (packageManager === 'npm') {
    manifest.overrides = resolutions;
  } else if (packageManager === 'pnpm') {
    manifest.pnpm = {overrides: resolutions};
  } else {
    manifest.resolutions = resolutions;
  }

  return manifest;
}

export function localeCatalogPaths(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null || !('i18n' in manifest)) {
    return [];
  }

  const i18n = manifest.i18n;

  if (typeof i18n !== 'object' || i18n === null || !('locales' in i18n)) {
    return [];
  }

  const locales = i18n.locales;

  if (typeof locales !== 'object' || locales === null || Array.isArray(locales)) {
    return [];
  }

  return Object.values(locales).filter((path): path is string => typeof path === 'string');
}

export function yarnBerryNeedsLockBoundary(version: string): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);

  return Number.isInteger(major) && major >= 2;
}

export function yarnBerryConfig(version: string): string {
  return yarnBerryNeedsLockBoundary(version) ? 'nodeLinker: node-modules\n' : '';
}

const importSpecifiers = (source: string): string[] => {
  const sourceFile = ts.createSourceFile('vite-module.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];

      if (argument !== undefined && ts.isStringLiteral(argument)) {
        specifiers.add(argument.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return [...specifiers];
};

const isViteServedModule = (url: URL): boolean => {
  return url.pathname.includes('/node_modules/') || url.pathname.startsWith('/@fs/')
    || url.pathname.startsWith('/@id/');
};

const isUiSvelteModule = (url: URL): boolean => {
  const path = decodeURIComponent(url.pathname).toLowerCase();

  return path.includes('@mndw_ui-svelte') || path.includes('@mndw/ui-svelte') || path.includes('svelte-cell');
};

export async function fetchUiSvelteImportGraph(
  appUrl: string,
  appSource: string,
  fetchModule: (url: string) => Promise<FetchResponse>,
): Promise<ImportedModule[]> {
  const base = new URL(appUrl);
  const entryUrls = importSpecifiers(appSource)
    .map((specifier) => new URL(specifier, base))
    .filter((url) => url.origin === base.origin && isViteServedModule(url) && isUiSvelteModule(url));

  if (entryUrls.length === 0) {
    throw new Error('Transformed /src/App.svelte did not import an installed @mndw/ui-svelte module');
  }

  const queue = [...entryUrls];
  const visited = new Set<string>();
  const modules: ImportedModule[] = [];

  while (queue.length > 0) {
    const url = queue.shift();

    if (url === undefined || visited.has(url.href)) {
      continue;
    }

    visited.add(url.href);

    const response = await fetchModule(url.href);
    const body = await response.text();

    if (response.status !== 200) {
      throw new Error(`Vite module request returned ${response.status}: ${url.href}\n${body.slice(0, 240)}`);
    }

    modules.push({url: url.href, body});

    for (const specifier of importSpecifiers(body)) {
      const imported = new URL(specifier, url);

      if (imported.origin === base.origin && isViteServedModule(imported) && !visited.has(imported.href)) {
        queue.push(imported);
      }
    }
  }

  if (modules.some(({body}) => containsUncompiledSvelteRuneCall(body))) {
    const offender = modules.find(({body}) => containsUncompiledSvelteRuneCall(body));

    throw new Error(`The installed @mndw/ui-svelte module still contains an uncompiled Svelte rune: ${offender?.url}`);
  }

  return modules;
}

const runCommand = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void => {
  const result = spawnSync(command, [...args], {cwd, env, stdio: 'inherit'});

  if (result.error !== undefined) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`);
  }

  if (result.signal !== null) {
    throw new Error(`${command} ${args.join(' ')} terminated by signal ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
};

const runCapture = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string => {
  const result = spawnSync(command, [...args], {cwd, env, encoding: 'utf8'});

  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  }

  return result.stdout.trim();
};

const getTarballs = async (repositoryRoot: string): Promise<TarballMap> => {
  const tarballDir = join(repositoryRoot, 'out/npm/tarballs');
  const tarballs: Record<string, string> = {};

  for (const [name, relativeDir] of Object.entries(OTHER_PACKAGE_DIRS)) {
    const manifest = await readJson(join(repositoryRoot, relativeDir, 'package.json'));

    if (typeof manifest.version !== 'string') {
      throw new Error(`${name} package.json has no version`);
    }

    tarballs[name] = join(tarballDir, `${name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`);
  }

  for (const platform of MNDWD_PLATFORMS) {
    const manifestPath = join(
      repositoryRoot,
      'build/npm/mndwd',
      platform.packageName.replace('@mndw/', ''),
      'package.json',
    );
    const manifest = await readJson(manifestPath);

    if (typeof manifest.version !== 'string') {
      throw new Error(`${platform.packageName} package.json has no version`);
    }

    tarballs[platform.packageName] = join(
      tarballDir,
      `${platform.packageName.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`,
    );
  }

  const selectedPlatform = mndwdPlatformFor(process.platform, process.arch);

  if (selectedPlatform === undefined) {
    throw new Error(`No packaged mndwd tarball supports ${process.platform}/${process.arch}`);
  }

  if (tarballs[selectedPlatform.packageName] === undefined) {
    throw new Error(`No tarball configured for ${selectedPlatform.packageName}`);
  }

  return tarballs;
};

const installCommand = (packageManager: PackageManager): string => packageManager;

export function packageManagerArgs(packageManager: PackageManager, yarnVersion?: string): string[] {
  if (packageManager === 'npm') {
    return ['install', '--no-audit', '--no-fund'];
  }

  if (packageManager === 'pnpm') {
    return ['install'];
  }

  if (yarnVersion === undefined) {
    throw new Error('Yarn version is required to choose install arguments');
  }

  return Number.parseInt(yarnVersion.split('.')[0] ?? '', 10) >= 2 ? ['install'] : ['install', '--non-interactive'];
}

const addPackageManagerOverrides = (
  manifest: PackageJson,
  packageManager: PackageManager,
  tarballs: TarballMap,
): void => {
  const overrides = Object.fromEntries(Object.entries(tarballs).map(([name, tarball]) => [name, fileSpec(tarball)]));

  if (packageManager === 'npm') {
    manifest.overrides = overrides;
  } else if (packageManager === 'pnpm') {
    manifest.pnpm = {overrides};
  } else {
    manifest.resolutions = overrides;
  }
};

const rewritePluginManifest = async (
  pluginDir: string,
  packageManager: PackageManager,
  tarballs: TarballMap,
): Promise<void> => {
  const manifestPath = join(pluginDir, 'package.json');
  const manifest = await readJson(manifestPath);

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const values = manifest[field];

    if (values === undefined) {
      continue;
    }

    for (const name of Object.keys(values)) {
      const tarball = tarballs[name];

      if (name.startsWith('@mndw/') && tarball !== undefined) {
        values[name] = fileSpec(tarball);
      }
    }
  }

  addPackageManagerOverrides(manifest, packageManager, tarballs);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

const getFreePort = async (): Promise<number> => {
  const server = createServer();

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a local TCP port');
  }

  const port = address.port;

  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error));
  });

  return port;
};

const waitForHttp200 = async (url: string, checkBody?: (body: string) => void): Promise<string> => {
  const deadline = Date.now() + 60_000;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(3_000)});
      const body = await response.text();

      if (response.status === 200) {
        checkBody?.(body);

        return body;
      }

      lastError = `HTTP ${response.status}: ${body.slice(0, 180)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
};

const stopChild = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exit = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolvePromise) => {
    child.once('exit', (code, signal) => resolvePromise({code, signal}));
  });

  child.kill('SIGINT');

  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    exit,
    new Promise<null>((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise(null), 10_000);
    }),
  ]);

  if (timeout !== undefined) {
    clearTimeout(timeout);
  }

  if (result === null) {
    child.kill('SIGKILL');
    throw new Error('mndw dev did not exit within 10 seconds after SIGINT');
  }
};

const startAndCheckDev = async (
  projectRoot: string,
  pluginDir: string,
  addr: string | undefined,
): Promise<string> => {
  const uiPort = await getFreePort();
  let daemonPort = await getFreePort();

  while (daemonPort === uiPort) {
    daemonPort = await getFreePort();
  }

  const args = ['dev', pluginDir, '--ui-port', String(uiPort), '--port', String(daemonPort)];

  if (addr !== undefined) {
    args.push('--addr', addr);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(projectRoot, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
  };

  if (addr === undefined) {
    delete env.MNDW_HOST_DEVICE;
  }

  const child = spawn('mndw', args, {cwd: projectRoot, env, stdio: 'inherit'});

  try {
    const origin = `http://127.0.0.1:${uiPort}`;
    const html = await waitForHttp200(`${origin}/`, (body) => {
      if (!body.includes('<script type="importmap">')) {
        throw new Error('Dev host HTML is missing its import map');
      }
    });

    await waitForHttp200(`${origin}/@mndw-dev/plugin.js`);

    const manifest = await readJson(join(projectRoot, pluginDir, 'manifest.json'));
    const catalogs = localeCatalogPaths(manifest);

    for (const catalog of catalogs) {
      await waitForHttp200(new URL(catalog, `${origin}/`).href);
    }

    const appUrl = `${origin}/src/App.svelte`;
    const appSource = await waitForHttp200(appUrl);
    const modules = await fetchUiSvelteImportGraph(appUrl, appSource, async (url) => {
      const response = await fetch(url, {signal: AbortSignal.timeout(10_000)});

      return {status: response.status, text: () => response.text()};
    });
    const moduleNames = modules.map(({url}) => new URL(url).pathname).join(', ');

    const localeDetail = catalogs.length === 0
      ? 'no locale catalogs declared'
      : `${catalogs.length} locale catalog(s) passed`;

    return `HTTP import map/plugin passed; ${localeDetail}; ${modules.length} wrapper module(s) fetched (${moduleNames}); host body ${html.length} bytes`;
  } finally {
    await stopChild(child);
  }
};

export function commandVersionArguments(command: string): string[] {
  return command === 'go' ? ['version'] : ['--version'];
}

export function backendSmokeOutputDir(projectRoot: string, target: string): string {
  return join(projectRoot, `backend-${target}`);
}

export async function assertBackendBinary(binaryPath: string): Promise<void> {
  let fileStat;

  try {
    fileStat = await stat(binaryPath);
  } catch {
    throw new Error(`backend binary is missing: ${binaryPath}`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`backend binary is not a file: ${binaryPath}`);
  }
}

const available = (command: string, env: NodeJS.ProcessEnv): boolean => {
  const result = spawnSync(command, commandVersionArguments(command), {env, stdio: 'ignore'});

  return result.error === undefined && result.status === 0;
};

const parseArgs = (args: readonly string[]): {packageManager: PackageManager; addr?: string} => {
  let packageManager: PackageManager = 'npm';
  let addr: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--pm') {
      const value = args[index + 1];

      index += 1;

      if (value !== 'npm' && value !== 'pnpm' && value !== 'yarn') {
        throw new Error('--pm must be npm, pnpm, or yarn');
      }

      packageManager = value;
    } else if (argument === '--addr') {
      addr = args[index + 1];
      index += 1;

      if (addr === undefined || addr.startsWith('--')) {
        throw new Error('--addr requires a device address');
      }
    } else {
      throw new Error(`Unknown smoke-npm option: ${argument}`);
    }
  }

  return {packageManager, addr};
};

const printRows = (rows: readonly SmokeRow[]): void => {
  const stepWidth = Math.max('Step'.length, ...rows.map(({step}) => step.length));
  const statusWidth = Math.max('Status'.length, ...rows.map(({status}) => status.length));

  process.stdout.write(`\n${'Step'.padEnd(stepWidth)}  ${'Status'.padEnd(statusWidth)}  Details\n`);
  process.stdout.write(`${'-'.repeat(stepWidth)}  ${'-'.repeat(statusWidth)}  -------\n`);

  for (const row of rows) {
    process.stdout.write(`${row.step.padEnd(stepWidth)}  ${row.status.padEnd(statusWidth)}  ${row.detail}\n`);
  }
};

const runSmokeStep = async (
  rows: SmokeRow[],
  name: string,
  work: () => Promise<string> | string,
): Promise<void> => {
  try {
    rows.push({step: name, status: 'pass', detail: await work()});
  } catch (error) {
    rows.push({step: name, status: 'fail', detail: error instanceof Error ? error.message : String(error)});
    throw error;
  }
};

const smokeCliEnvironment = (projectRoot: string): NodeJS.ProcessEnv => {
  return {
    ...process.env,
    PATH: `${join(projectRoot, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
  };
};

const installRootPackages = async (
  projectRoot: string,
  repositoryRoot: string,
  packageManager: PackageManager,
  rows: SmokeRow[],
): Promise<TarballMap> => {
  const tarballs = await getTarballs(repositoryRoot);

  await runSmokeStep(rows, 'npm init', () => {
    runCommand('npm', ['init', '-y'], projectRoot, process.env);

    return 'completed';
  });

  const projectManifest = buildPackageManagerManifest(
    packageManager,
    tarballs,
    Object.keys(OTHER_PACKAGE_DIRS),
  );
  const platform = mndwdPlatformFor(process.platform, process.arch);

  if (platform === undefined) {
    throw new Error(`No mndwd package for ${process.platform}/${process.arch}`);
  }

  const rootDependencies = projectManifest.dependencies as Record<string, string>;
  const daemonTarball = tarballs[platform.packageName];

  if (daemonTarball === undefined) {
    throw new Error(`No local tarball for ${platform.packageName}`);
  }

  rootDependencies[platform.packageName] = fileSpec(daemonTarball);
  await writeFile(join(projectRoot, 'package.json'), `${JSON.stringify(projectManifest, null, 2)}\n`);

  let yarnVersion: string | undefined;

  if (packageManager === 'yarn') {
    yarnVersion = runCapture('yarn', ['--version'], projectRoot, process.env);

    const config = yarnBerryConfig(yarnVersion);

    if (config.length > 0) {
      await writeFile(join(projectRoot, '.yarnrc.yml'), config);
    }
  }

  await runSmokeStep(rows, `${packageManager} root install`, () => {
    runCommand(
      installCommand(packageManager),
      packageManagerArgs(packageManager, yarnVersion),
      projectRoot,
      process.env,
    );

    return 'installed eight local tarballs with local @mndw overrides';
  });

  return tarballs;
};

const installSvelteDemo = async (
  projectRoot: string,
  packageManager: PackageManager,
  tarballs: TarballMap,
  rows: SmokeRow[],
): Promise<void> => {
  await runSmokeStep(rows, 'create Svelte demo', () => {
    runCommand(
      'npx',
      ['mndw', 'create', 'demo', '--framework', 'svelte', '--no-install'],
      projectRoot,
      process.env,
    );

    return 'scaffolded demo';
  });

  const demoRoot = join(projectRoot, 'demo');
  const yarnVersion = packageManager === 'yarn'
    ? runCapture('yarn', ['--version'], demoRoot, process.env)
    : undefined;

  if (yarnVersion !== undefined && yarnBerryNeedsLockBoundary(yarnVersion)) {
    await writeFile(join(demoRoot, 'yarn.lock'), '');
  }

  await rewritePluginManifest(demoRoot, packageManager, tarballs);
  await runSmokeStep(rows, `${packageManager} demo install`, () => {
    runCommand(installCommand(packageManager), packageManagerArgs(packageManager, yarnVersion), demoRoot, process.env);

    return 'installed demo dependencies from local tarballs';
  });

  const env = smokeCliEnvironment(projectRoot);

  for (const command of ['validate', 'pack', 'zip'] as const) {
    await runSmokeStep(rows, `mndw ${command}`, () => {
      runCommand('mndw', [command, 'demo'], projectRoot, env);

      return 'completed';
    });
  }
};

const runGoBackendSmoke = async (projectRoot: string, rows: SmokeRow[]): Promise<void> => {
  if (!available('go', process.env)) {
    rows.push({step: 'Go backend smoke', status: 'skipped', detail: 'go is not on PATH'});

    return;
  }

  await runSmokeStep(rows, 'Go backend smoke', async () => {
    const env = smokeCliEnvironment(projectRoot);

    runCommand(
      'mndw',
      ['create', 'demo-go', '--backend', 'go', '--type', 'page', '--framework', 'vanilla', '--no-install'],
      projectRoot,
      env,
    );

    const target = PRODUCT_TARGETS[0];

    if (target === undefined) {
      throw new Error('No IPK target is configured');
    }

    const pluginRoot = join(projectRoot, 'demo-go');
    const pluginManifest = await readJson(join(pluginRoot, 'package.json'));
    const binaryName = pluginManifest.mndw?.backend?.binaryName;

    if (typeof binaryName !== 'string' || binaryName.length === 0) {
      throw new Error('demo-go package.json has no mndw.backend.binaryName');
    }

    const outputDir = backendSmokeOutputDir(projectRoot, target);

    runCommand('mndw', ['build-backend', '--target', target, '--out-dir', outputDir], pluginRoot, env);
    await assertBackendBinary(join(outputDir, binaryName));
    runCommand('mndw', ['pack', 'demo-go'], projectRoot, env);

    return `built and packed Go backend for ${target}`;
  });
};

const runDevSmoke = (projectRoot: string, addr: string | undefined, rows: SmokeRow[]): Promise<void> => {
  return runSmokeStep(rows, 'mndw dev HTTP and wrapper', () => {
    return startAndCheckDev(projectRoot, 'demo', addr);
  });
};

export async function runFreshProjectSmoke(options: {
  readonly repositoryRoot: string;
  readonly packageManager: PackageManager;
  readonly addr?: string;
}): Promise<void> {
  const rows: SmokeRow[] = [];
  const repositoryRoot = resolve(options.repositoryRoot);
  let tempRoot: string | undefined;
  let succeeded = false;

  try {
    if (!available(options.packageManager, process.env)) {
      throw new Error(`${options.packageManager} is not on PATH`);
    }

    const projectRoot = await mkdtemp(join(tmpdir(), `mndw-smoke-${options.packageManager}-`));

    tempRoot = projectRoot;

    const tarballs = await installRootPackages(projectRoot, repositoryRoot, options.packageManager, rows);

    await installSvelteDemo(projectRoot, options.packageManager, tarballs, rows);
    await runGoBackendSmoke(projectRoot, rows);
    await runDevSmoke(projectRoot, options.addr, rows);

    succeeded = true;
  } catch (error) {
    if (!rows.some(({status}) => status === 'fail')) {
      rows.push({step: 'setup', status: 'fail', detail: error instanceof Error ? error.message : String(error)});
    }
  } finally {
    printRows(rows);

    if (tempRoot !== undefined && succeeded) {
      await rm(tempRoot, {recursive: true, force: true});
    } else if (tempRoot !== undefined) {
      process.stderr.write(`Smoke project retained at ${tempRoot}\n`);
    }
  }

  if (!succeeded) {
    process.exitCode = 1;
  }
}

const isMainModule = (url: string): boolean => {
  const entry = process.argv[1];

  return entry !== undefined && pathToFileURL(resolve(entry)).href === url;
};

if (isMainModule(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  void runFreshProjectSmoke({repositoryRoot, ...parseArgs(process.argv.slice(2))}).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
