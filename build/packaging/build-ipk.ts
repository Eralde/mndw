import fs, {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {pack as tarPack} from 'tar-stream';
import crossSpawn from 'cross-spawn';
import {GO_TARGETS} from '@mndw/cli/go-target';
import {PRODUCT_TARGETS, PRODUCT_TARGET_CONFIG, type ProductTarget, isProductTarget} from '../targets.js';
import {buildProductTargetWithDefaults} from '../index.js';
import type {ArtifactDescriptor, SharedArtifacts} from '../artifacts/descriptor.js';

/** Compatibility export; values derive from shared product target metadata. */
export const ARCH_MAP = GO_TARGETS;

export function opkgArchForTarget(target: ProductTarget): string {
  return PRODUCT_TARGET_CONFIG[target].opkgArch;
}

interface SharedDependencySnapshot {
  readonly bundles: readonly {readonly url: string}[];
}

function generatedSharedBundlePaths(repoRoot = path.resolve(import.meta.dirname, '..', '..')): string[] {
  const snapshotPath = path.join(repoRoot, 'contracts', 'protocol', 'shared-deps.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SharedDependencySnapshot;

  return snapshot.bundles.map((bundle) => bundle.url.replace(/^\//, ''));
}

/** Fixed timestamp for reproducible archives (no dependency on build time or host clock). */
const TAR_MTIME = new Date(0);

/** macOS/AppleDouble metadata files that must never enter the package. */
export function isMetadataFile(baseName: string): boolean {
  return baseName === '.DS_Store' || baseName.startsWith('._');
}

/**
 * Resolve the POSIX file mode for a staged path from an explicit policy rather than the
 * on-disk permission bits. Host filesystems (notably Windows) do not carry Unix modes, so the
 * archive must set them authoritatively for the target device.
 */
export function dataFileMode(relPosixPath: string): number {
  const segments = relPosixPath.split('/');
  const baseName = segments[segments.length - 1] ?? '';
  const isExecutable = relPosixPath === 'opt/sbin/mndwd'
    || segments.includes('init.d')
    || (segments.includes('bin') && baseName.endsWith('.sh'))
    || segments.includes('backend');

  if (relPosixPath === 'opt/etc/mndw.conf') { return 0o600; }

  if (isExecutable) { return 0o755; }

  return 0o644;
}

export interface TarFileEntry {
  readonly name: string;
  readonly mode: number;
  /** File contents; omit (or undefined) for a directory entry. */
  readonly content?: Buffer;
}

/** Write a gzipped ustar archive with fully controlled, root-owned headers (no external tar). */
export async function writeTarGz(entries: readonly TarFileEntry[], outPath: string): Promise<void> {
  const pack = tarPack();
  const done = pipeline(pack, zlib.createGzip(), fs.createWriteStream(outPath));

  for (const entry of entries) {
    const isDirectory = entry.content === undefined;

    pack.entry({
      name: entry.name,
      mode: entry.mode,
      size: isDirectory ? 0 : entry.content.length,
      type: isDirectory ? 'directory' : 'file',
      uid: 0,
      gid: 0,
      uname: 'root',
      gname: 'root',
      mtime: TAR_MTIME,
    }, entry.content ?? Buffer.alloc(0));
  }

  pack.finalize();

  await done;
}

interface StagedEntries {
  readonly dirs: string[];
  readonly files: string[];
}

/** Recursively collect directories and regular files under `root` as POSIX-relative paths. */
function collectEntries(root: string, rel = '', into: StagedEntries = {dirs: [], files: []}): StagedEntries {
  for (const dirent of fs.readdirSync(path.join(root, rel), {withFileTypes: true})) {
    if (isMetadataFile(dirent.name)) { continue; }

    const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;

    if (dirent.isDirectory()) {
      into.dirs.push(childRel);
      collectEntries(root, childRel, into);
    } else if (dirent.isFile()) {
      into.files.push(childRel);
    }
  }

  return into;
}

export function substituteControl(template: string, version: string, arch: string): string {
  return template.replace(/__VERSION__/g, version).replace(/__ARCH__/g, arch);
}

export function collectStagePaths(): {
  mndwd: string;
  indexHtml: string;
  assets: string;
  initScript: string;
  devicePortHelper: string;
  daemonConfig: string;
} {
  return {
    mndwd: path.join('opt', 'sbin', 'mndwd'),
    indexHtml: path.join('opt', 'share', 'www', 'mndw', 'index.html'),
    assets: path.join('opt', 'share', 'www', 'mndw', 'assets'),
    initScript: path.join('opt', 'etc', 'init.d', 'S70mndwd'),
    devicePortHelper: path.join('opt', 'share', 'www', 'mndw', 'bin', 'mndw-device-port.sh'),
    daemonConfig: path.join('opt', 'etc', 'mndw.conf'),
  };
}

export function verifyStage(
  stagingDir: string,
  sharedBundlePaths: readonly string[] = generatedSharedBundlePaths(),
): void {
  const missing: string[] = [];
  const p = collectStagePaths();
  const checks: [string, string][] = [
    [p.mndwd, 'daemon binary'],
    [p.indexHtml, 'index.html'],
    [p.assets, 'assets directory'],
    [p.initScript, 'init script'],
    [p.devicePortHelper, 'device port helper'],
    [p.daemonConfig, 'daemon config'],
  ];

  for (const [relPath, label] of checks) {
    const fullPath = path.join(stagingDir, relPath);
    const exists = fs.existsSync(fullPath);
    const expectsDirectory = relPath === p.assets;
    const isDirectory = exists && fs.statSync(fullPath).isDirectory();

    if (!exists || (expectsDirectory && !isDirectory) || (!expectsDirectory && isDirectory)) {
      missing.push(`${label} (${relPath})`);
    }
  }

  for (const bundle of sharedBundlePaths) {
    const bundlePath = path.join(stagingDir, 'opt', 'share', 'www', 'mndw', bundle);

    if (!fs.existsSync(bundlePath) || fs.statSync(bundlePath).isDirectory()) {
      missing.push(`shared bundle (${bundle})`);
    }
  }

  const pluginsDir = path.join(stagingDir, 'opt', 'share', 'www', 'mndw', 'plugins');

  if (!fs.existsSync(pluginsDir) || !fs.statSync(pluginsDir).isDirectory() || fs.readdirSync(pluginsDir).length === 0) {
    missing.push('builtin plugins directory (at least one plugin required)');
  }

  if (missing.length > 0) {
    throw new Error(`Missing staging files:\n  - ${missing.join('\n  - ')}`);
  }
}

export function verifyElfBytes(binary: Uint8Array, target: ProductTarget): void {
  if (binary.length < 20) {
    throw new Error(`ELF header is truncated for target ${target}`);
  }

  if (binary[0] !== 0x7f || binary[1] !== 0x45 || binary[2] !== 0x4c || binary[3] !== 0x46) {
    throw new Error(`binary is not an ELF file for target ${target}`);
  }

  const elfClass = binary[4];
  const dataEncoding = binary[5];

  if (elfClass !== 1 && elfClass !== 2) {
    throw new Error(`unsupported ELF class for target ${target}`);
  }

  if (dataEncoding !== 1 && dataEncoding !== 2) {
    throw new Error(`unsupported ELF byte order for target ${target}`);
  }

  const expectedClass = target === 'aarch64' ? 2 : 1;
  const expectedDataEncoding = target === 'mips' ? 2 : 1;

  if (elfClass !== expectedClass) {
    throw new Error(`ELF class does not match target ${target}`);
  }

  if (dataEncoding !== expectedDataEncoding) {
    throw new Error(`ELF byte order does not match target ${target}`);
  }

  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const machine = view.getUint16(18, dataEncoding === 1);
  const expectedMachine = target === 'aarch64' ? 183 : 8;

  if (machine !== expectedMachine) {
    throw new Error(`ELF machine does not match target ${target}`);
  }
}

export function verifyElf(binaryPath: string, target: ProductTarget): void {
  const binary = fs.readFileSync(binaryPath);

  verifyElfBytes(binary, target);
}

export function verifyAllElf(stagingDir: string, target: ProductTarget): void {
  verifyElf(path.join(stagingDir, 'opt', 'sbin', 'mndwd'), target);

  const pluginsDir = path.join(stagingDir, 'opt', 'share', 'www', 'mndw', 'plugins');

  if (!fs.existsSync(pluginsDir)) { return; }

  for (const pluginName of fs.readdirSync(pluginsDir)) {
    const backendDir = path.join(pluginsDir, pluginName, 'backend');

    if (!fs.existsSync(backendDir)) { continue; }

    for (const file of fs.readdirSync(backendDir)) {
      const fullPath = path.join(backendDir, file);

      if (!fs.statSync(fullPath).isFile()) { continue; }

      const bytes = fs.readFileSync(fullPath);

      if (bytes.length < 4 || bytes.subarray(0, 4).toString('ascii') !== '\x7fELF') { continue; }

      verifyElf(fullPath, target);
    }
  }
}

export function readVersion(repoRoot: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {version?: unknown};

  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('Root package.json has no version');
  }

  return pkg.version;
}

export function stageBuiltinPlugins(repoRoot: string, stagingDir: string): void {
  const builtinDist = path.join(repoRoot, 'plugins/builtin', 'dist');

  if (!fs.existsSync(builtinDist)) {
    throw new Error('plugins/builtin/dist not found — run build-builtin-plugins first');
  }

  fs.cpSync(builtinDist, path.join(stagingDir, 'opt', 'share', 'www', 'mndw', 'plugins'), {recursive: true});
}

export function stageDeployFiles(repoRoot: string, stagingDir: string): void {
  const deployDir = path.join(repoRoot, 'build', 'packaging');
  const copyTo = (srcRel: string, dstRel: string, chmod?: number): void => {
    const dst = path.join(stagingDir, dstRel);

    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.copyFileSync(path.join(deployDir, srcRel), dst);

    if (chmod !== undefined) { fs.chmodSync(dst, chmod); }
  };

  copyTo(path.join('init', 'S70mndwd'), path.join('opt', 'etc', 'init.d', 'S70mndwd'), 0o755);
  copyTo(path.join('files', 'opt', 'etc', 'mndw.conf'), path.join('opt', 'etc', 'mndw.conf'), 0o600);
  copyTo(
    path.join('files', 'opt', 'share', 'www', 'mndw', 'bin', 'mndw-device-port.sh'),
    path.join('opt', 'share', 'www', 'mndw', 'bin', 'mndw-device-port.sh'),
    0o755,
  );
}

export async function buildDataTar(stagingDir: string, outDir: string): Promise<string> {
  const outPath = path.join(outDir, 'data.tar.gz');
  const {dirs, files} = collectEntries(stagingDir);

  // Directory entries must precede their contents; opkg's BusyBox tar does not create
  // parent directories implicitly. Lexicographic order guarantees each parent precedes its children.
  const dirEntries: TarFileEntry[] = [...dirs].sort()
    .map((relPosixPath) => ({name: `./${relPosixPath}/`, mode: 0o755}));
  const fileEntries: TarFileEntry[] = files.map((relPosixPath) => ({
    name: `./${relPosixPath}`,
    mode: dataFileMode(relPosixPath),
    content: fs.readFileSync(path.join(stagingDir, relPosixPath)),
  }));

  await writeTarGz([...dirEntries, ...fileEntries], outPath);

  return outPath;
}

export async function buildControlTar(
  ipkDir: string,
  outDir: string,
  version: string,
  arch: string,
): Promise<string> {
  const template = fs.readFileSync(path.join(ipkDir, 'control'), 'utf8');
  const entries: TarFileEntry[] = [
    {name: './control', mode: 0o644, content: Buffer.from(substituteControl(template, version, arch))},
  ];

  for (const s of ['conffiles', 'preinst', 'postinst', 'prerm', 'postrm']) {
    const src = path.join(ipkDir, s);

    if (!fs.existsSync(src)) {
      throw new Error(`Missing required ipk control file: build/packaging/ipk/${s}`);
    }

    const raw = fs.readFileSync(src, 'utf8');
    const content = s === 'postinst' ? substituteControl(raw, version, arch) : raw;

    entries.push({
      name: `./${s}`,
      mode: s === 'conffiles' ? 0o644 : 0o755,
      content: Buffer.from(content),
    });
  }

  const outPath = path.join(outDir, 'control.tar.gz');

  await writeTarGz(entries, outPath);

  return outPath;
}

export async function buildIpk(
  dataTarPath: string,
  controlTarPath: string,
  outDir: string,
  version: string,
  arch: string,
): Promise<string> {
  const ipkName = `mndw_${version}_${arch}.ipk`;
  const ipkPath = path.join(outDir, ipkName);
  const entries: TarFileEntry[] = [
    {name: './debian-binary', mode: 0o644, content: Buffer.from('2.0\n')},
    {name: './data.tar.gz', mode: 0o644, content: fs.readFileSync(dataTarPath)},
    {name: './control.tar.gz', mode: 0o644, content: fs.readFileSync(controlTarPath)},
  ];

  await writeTarGz(entries, ipkPath);

  return ipkPath;
}

export interface IpkInfo {
  arch: string;
  filename: string;
  size: number;
  sha256: string;
}

type FeedIpkInfo = IpkInfo & {readonly sourcePath: string};

export function generateFeed(version: string, ipks: IpkInfo[]): string {
  return ipks.map((ipk) =>
    [
      'Package: mndw',
      `Version: ${version}`,
      'Section: web',
      `Architecture: ${ipk.arch}`,
      `Filename: ${ipk.filename}`,
      `Size: ${ipk.size}`,
      `SHA256sum: ${ipk.sha256}`,
      'Description: Modular plugin-based dashboard served by mndwd.',
    ].join('\n')
  ).join('\n\n') + '\n';
}

export function writeFeed(ipkPaths: string[], version: string, repoDir: string): void {
  const ipks: FeedIpkInfo[] = [];
  const supportedOpkgArches = new Set(PRODUCT_TARGETS.map((target) => opkgArchForTarget(target)));
  const seenArches = new Set<string>();

  for (const ipkPath of ipkPaths) {
    const filename = path.basename(ipkPath);
    const archMatch = filename.match(/^mndw_([^_]+)_(.+)\.ipk$/);

    if (archMatch === null) {
      throw new Error(`Unexpected ipk filename: ${filename}`);
    }

    const packageVersion = archMatch[1];
    const arch = archMatch[2];

    if (packageVersion !== version || !supportedOpkgArches.has(arch)) {
      throw new Error(`Unexpected ipk filename: ${filename}`);
    }

    const stat = fs.lstatSync(ipkPath);

    if (!stat.isFile()) {
      throw new Error(`IPK is not a regular file: ${ipkPath}`);
    }

    if (seenArches.has(arch)) {
      throw new Error(`Duplicate architecture: ${arch}`);
    }

    seenArches.add(arch);

    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(ipkPath))
      .digest('hex');

    ipks.push({arch, filename, size: stat.size, sha256, sourcePath: ipkPath});
  }

  const byArch = new Map<string, FeedIpkInfo[]>();

  for (const ipk of ipks) {
    const entries = byArch.get(ipk.arch) ?? [];

    entries.push(ipk);
    byArch.set(ipk.arch, entries);
  }

  fs.rmSync(repoDir, {recursive: true, force: true});
  fs.mkdirSync(repoDir, {recursive: true});

  for (const arch of [...byArch.keys()].sort()) {
    const archDir = path.join(repoDir, arch);
    const entries = byArch.get(arch) ?? [];
    const packages = generateFeed(version, entries);

    fs.mkdirSync(archDir, {recursive: true});

    for (const entry of entries) {
      fs.copyFileSync(entry.sourcePath, path.join(archDir, entry.filename));
    }

    fs.writeFileSync(path.join(archDir, 'Packages'), packages);
    fs.writeFileSync(path.join(archDir, 'Packages.gz'), zlib.gzipSync(packages));
  }
}

export function parseArgs(args: string[]): {arch: string | null; all: boolean; repo: boolean} {
  let arch: string | null = null;
  let all = false;
  let repo = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--arch':
        arch = args[++i] ?? null;

        if (!arch) { throw new Error('Missing value for --arch'); }

        if (!isProductTarget(arch)) {
          throw new Error(`Unknown architecture: ${arch}. Valid: ${PRODUCT_TARGETS.join(', ')}`);
        }

        break;
      case '--all':
        all = true;
        break;
      case '--repo':
        repo = true;
        break;
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  if (!all && !arch) { throw new Error('must specify --arch or --all'); }

  return {arch, all, repo};
}

function requireCommand(command: string, args: string[]): void {
  const result = crossSpawn.sync(command, args, {stdio: 'ignore'});

  if (result.error || result.status !== 0) { throw new Error(`Required command not found or failed: ${command}`); }
}

export function ensureBuildPrereqs(repoRoot: string): void {
  requireCommand('go', ['version']);

  const nodeModulesDir = path.join(repoRoot, 'node_modules');

  if (!fs.existsSync(nodeModulesDir)) {
    const install = crossSpawn.sync('pnpm', ['install', '--frozen-lockfile'], {cwd: repoRoot, stdio: 'inherit'});

    if (install.error || install.status !== 0) { throw new Error('pnpm install --frozen-lockfile failed'); }
  }

  const hostBuild = crossSpawn.sync('pnpm', ['--filter', '@mndw/host', 'build'], {cwd: repoRoot, stdio: 'inherit'});

  if (hostBuild.error || hostBuild.status !== 0) { throw new Error('host build failed'); }

  const pluginBuild = crossSpawn.sync('pnpm', ['build-builtin-plugins'], {cwd: repoRoot, stdio: 'inherit'});

  if (pluginBuild.error || pluginBuild.status !== 0) { throw new Error('build-builtin-plugins failed'); }
}

function stageSharedArtifacts(repoRoot: string, stagingDir: string, shared: SharedArtifacts): void {
  const webRoot = path.join(stagingDir, 'opt', 'share', 'www', 'mndw');
  const frontendRoot = path.join(repoRoot, shared.frontend.root);

  if (!fs.existsSync(frontendRoot)) {
    throw new Error(`frontend artifact root not found: ${frontendRoot}`);
  }

  fs.cpSync(frontendRoot, webRoot, {recursive: true});

  for (const plugin of shared.plugins) {
    const source = path.join(repoRoot, plugin.bundle);
    const destination = path.join(webRoot, 'plugins', plugin.name);

    if (!fs.existsSync(source)) {
      throw new Error(`plugin artifact root not found: ${source}`);
    }

    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.cpSync(source, destination, {recursive: true});
  }
}

function stageTargetArtifacts(
  repoRoot: string,
  stagingDir: string,
  descriptor: ArtifactDescriptor,
  target: ProductTarget,
): void {
  const targetArtifacts = descriptor.targets[target];

  if (targetArtifacts === undefined) {
    throw new Error(`artifact descriptor has no target block: ${target}`);
  }

  const daemonDestination = path.join(stagingDir, 'opt', 'sbin', 'mndwd');

  fs.mkdirSync(path.dirname(daemonDestination), {recursive: true});
  fs.copyFileSync(path.join(repoRoot, targetArtifacts.daemon), daemonDestination);

  for (const binary of targetArtifacts.pluginBinaries) {
    const destination = path.join(stagingDir, binary.destination);

    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(path.join(repoRoot, binary.source), destination);
    fs.chmodSync(destination, 0o755);
  }
}

export async function buildOneArch(arch: string, repoRoot: string, version: string): Promise<string> {
  if (!isProductTarget(arch)) { throw new Error(`Unknown architecture: ${arch}`); }

  const targetConfig = PRODUCT_TARGET_CONFIG[arch];

  const outDir = path.join(repoRoot, 'out');

  fs.mkdirSync(outDir, {recursive: true});

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-staging-'));
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-build-'));
  const artifactRoot = fs.mkdtempSync(path.join(repoRoot, '.mndw-artifacts-'));

  try {
    const descriptor = buildProductTargetWithDefaults(
      repoRoot,
      arch,
      artifactRoot,
      path.join(artifactRoot, 'artifact-descriptor.json'),
      version,
    );

    stageSharedArtifacts(repoRoot, stagingDir, descriptor.shared);
    stageDeployFiles(repoRoot, stagingDir);
    stageTargetArtifacts(repoRoot, stagingDir, descriptor, arch);
    verifyStage(stagingDir, descriptor.shared.frontend.sharedBundles);
    verifyAllElf(stagingDir, arch);

    const dataTarPath = await buildDataTar(stagingDir, buildDir);
    const controlTarPath = await buildControlTar(
      path.join(repoRoot, 'build', 'packaging', 'ipk'),
      buildDir,
      version,
      targetConfig.opkgArch,
    );

    return await buildIpk(dataTarPath, controlTarPath, outDir, version, targetConfig.opkgArch);
  } finally {
    fs.rmSync(stagingDir, {recursive: true, force: true});
    fs.rmSync(buildDir, {recursive: true, force: true});
    fs.rmSync(artifactRoot, {recursive: true, force: true});
  }
}

export async function main(args: string[]): Promise<void> {
  const {arch, all, repo} = parseArgs(args);
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const version = readVersion(repoRoot);

  ensureBuildPrereqs(repoRoot);

  const arches = all ? [...PRODUCT_TARGETS] : arch === null ? [] : [arch];
  const ipkPaths: string[] = [];

  for (const a of arches) {
    console.log(`Building for ${a}...`);

    const ipkPath = await buildOneArch(a, repoRoot, version);

    ipkPaths.push(ipkPath);
    console.log(`  -> ${ipkPath}`);
  }

  if (repo && ipkPaths.length > 0) {
    const repoDir = path.join(repoRoot, 'out', 'repo');

    console.log(`Generating feed at ${repoDir}...`);
    writeFeed(ipkPaths, version, repoDir);
  }
}

export function isMainModule(moduleUrl: string, scriptPath: string | undefined): boolean {
  return scriptPath !== undefined && moduleUrl === pathToFileURL(path.resolve(scriptPath)).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
