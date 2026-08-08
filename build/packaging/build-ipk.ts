import fs, {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execSync, spawnSync} from 'node:child_process';
import zlib from 'node:zlib';
import {GO_TARGETS} from '../../daemon/mndwd/scripts/build-target.js';
import {PRODUCT_TARGETS, type ProductTarget, isProductTarget} from '../targets.js';
import {buildProductTargetWithDefaults} from '../index.js';
import type {ArtifactDescriptor, SharedArtifacts} from '../artifacts/descriptor.js';

/** Compatibility export; target mapping authority lives with daemon build entries. */
export const ARCH_MAP = GO_TARGETS;

interface SharedDependencySnapshot {
  readonly bundles: readonly {readonly url: string}[];
}

function generatedSharedBundlePaths(repoRoot = path.resolve(import.meta.dirname, '..', '..')): string[] {
  const snapshotPath = path.join(repoRoot, 'contracts', 'protocol', 'shared-deps.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SharedDependencySnapshot;

  return snapshot.bundles.map((bundle) => bundle.url.replace(/^\//, ''));
}

export function detectTar(versionOutput: string): string[] {
  if (versionOutput.includes('GNU tar')) {
    return ['--owner=0', '--group=0', '--numeric-owner'];
  }

  return ['--uid=0', '--gid=0', '--uname=root', '--gname=root'];
}

export function substituteControl(template: string, version: string, arch: string): string {
  return template.replace(/__VERSION__/g, version).replace(/__ARCH__/g, arch);
}

export function collectStagePaths(): {
  mndwd: string;
  indexHtml: string;
  assets: string;
  lighttpdConf: string;
  initScript: string;
  moduleGuard: string;
  daemonConfig: string;
} {
  return {
    mndwd: path.join('opt', 'sbin', 'mndwd'),
    indexHtml: path.join('opt', 'share', 'www', 'mndw', 'index.html'),
    assets: path.join('opt', 'share', 'www', 'mndw', 'assets'),
    lighttpdConf: path.join('opt', 'etc', 'lighttpd', 'conf.d', '80-mndw.conf'),
    initScript: path.join('opt', 'etc', 'init.d', 'S70mndwd'),
    moduleGuard: path.join('opt', 'share', 'www', 'mndw', 'bin', 'mndw-load-modules.sh'),
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
    [p.lighttpdConf, 'lighttpd config'],
    [p.initScript, 'init script'],
    [p.moduleGuard, 'module guard script'],
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

const FILE_ARCH_MARKERS: Record<string, string[]> = {
  'mipsel-3.4': ['ELF 32-bit', 'MIPS'],
  'aarch64-3.10': ['ELF 64-bit', 'aarch64'],
  'armv7-3.2': ['ELF 32-bit', 'ARM', 'not aarch64'],
};

export function verifyElfWithExec(binaryPath: string, targetArch: string, execFn: () => string): void {
  const fileOutput = execFn();
  const markers = FILE_ARCH_MARKERS[targetArch];

  if (!markers) {
    throw new Error(`Unknown target arch: ${targetArch}`);
  }

  for (const marker of markers) {
    if (marker.startsWith('not ')) {
      const excluded = marker.slice(4);

      if (fileOutput.includes(excluded)) {
        throw new Error(
          `Binary at ${binaryPath} does not match target ${targetArch}: contains excluded marker ${excluded}: ${fileOutput}`,
        );
      }
    } else if (!fileOutput.includes(marker)) {
      throw new Error(
        `Binary at ${binaryPath} does not match target ${targetArch}: missing marker ${marker}: ${fileOutput}`,
      );
    }
  }
}

export function verifyElf(binaryPath: string, targetArch: string): void {
  verifyElfWithExec(binaryPath, targetArch, () => execSync(`file "${binaryPath}"`, {encoding: 'utf8'}).trim());
}

export function verifyAllElf(stagingDir: string, targetArch: string): void {
  verifyElf(path.join(stagingDir, 'opt', 'sbin', 'mndwd'), targetArch);

  const pluginsDir = path.join(stagingDir, 'opt', 'share', 'www', 'mndw', 'plugins');

  if (!fs.existsSync(pluginsDir)) { return; }

  for (const pluginName of fs.readdirSync(pluginsDir)) {
    const backendDir = path.join(pluginsDir, pluginName, 'backend');

    if (!fs.existsSync(backendDir)) { continue; }

    for (const file of fs.readdirSync(backendDir)) {
      const fullPath = path.join(backendDir, file);

      if (!fs.statSync(fullPath).isFile()) { continue; }

      const fileType = execSync(`file "${fullPath}"`, {encoding: 'utf8'}).trim();

      if (!fileType.includes('ELF')) { continue; }

      verifyElf(fullPath, targetArch);
    }
  }
}

export function stageHostOutput(repoRoot: string, stagingDir: string): void {
  const hostDist = path.join(repoRoot, 'packages', 'host', 'dist');

  if (!fs.existsSync(hostDist)) {
    throw new Error('frontend/host/dist not found — run host build first');
  }

  fs.cpSync(hostDist, path.join(stagingDir, 'opt', 'share', 'www', 'mndw'), {recursive: true});
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

  copyTo(path.join('lighttpd', '80-mndw.conf'), path.join('opt', 'etc', 'lighttpd', 'conf.d', '80-mndw.conf'));
  copyTo(path.join('init', 'S70mndwd'), path.join('opt', 'etc', 'init.d', 'S70mndwd'), 0o755);
  copyTo(path.join('files', 'opt', 'etc', 'mndw.conf'), path.join('opt', 'etc', 'mndw.conf'), 0o600);
  copyTo(
    path.join('files', 'opt', 'share', 'www', 'mndw', 'bin', 'mndw-load-modules.sh'),
    path.join('opt', 'share', 'www', 'mndw', 'bin', 'mndw-load-modules.sh'),
    0o755,
  );
}

export function getTarVersion(): string {
  return execSync('tar --version', {encoding: 'utf8'}).split('\n')[0] || '';
}

export function getTarOwnerOpts(): string[] {
  return detectTar(getTarVersion());
}

export function buildDataTar(stagingDir: string, outDir: string): string {
  execSync(`find "${stagingDir}" -name "._*" -delete 2>/dev/null || true`);
  execSync(`find "${stagingDir}" -name ".DS_Store" -delete 2>/dev/null || true`);

  const tarOpts = getTarOwnerOpts();
  const outPath = path.join(outDir, 'data.tar.gz');

  execSync(
    `COPYFILE_DISABLE=1 tar ${tarOpts.join(' ')} --format=ustar -C "${stagingDir}" -czf "${outPath}" ./opt`,
    {stdio: 'inherit'},
  );

  return outPath;
}

export function buildControlTar(ipkDir: string, outDir: string, version: string, arch: string): string {
  const template = fs.readFileSync(path.join(ipkDir, 'control'), 'utf8');
  const content = substituteControl(template, version, arch);
  const ctrlRoot = path.join(outDir, '.control-staging');
  const ctrlDir = path.join(ctrlRoot, 'control');

  fs.mkdirSync(ctrlDir, {recursive: true});

  try {
    fs.writeFileSync(path.join(ctrlDir, 'control'), content);

    for (const s of ['conffiles', 'preinst', 'postinst', 'prerm', 'postrm']) {
      const src = path.join(ipkDir, s);

      if (!fs.existsSync(src)) {
        throw new Error(`Missing required ipk control file: build/packaging/ipk/${s}`);
      }

      fs.copyFileSync(src, path.join(ctrlDir, s));

      if (s !== 'conffiles') { fs.chmodSync(path.join(ctrlDir, s), 0o755); }
    }

    const tarOpts = getTarOwnerOpts();
    const outPath = path.join(outDir, 'control.tar.gz');
    const files = fs.readdirSync(ctrlDir).map((f) => `./${f}`)
      .join(' ');

    execSync(
      `COPYFILE_DISABLE=1 tar ${tarOpts.join(' ')} --format=ustar -C "${ctrlDir}" -czf "${outPath}" ${files}`,
      {stdio: 'inherit'},
    );

    return outPath;
  } finally {
    fs.rmSync(ctrlRoot, {recursive: true, force: true});
  }
}

export function buildIpk(
  dataTarPath: string,
  controlTarPath: string,
  outDir: string,
  version: string,
  arch: string,
): string {
  const ipkName = `mndw_${version}_${arch}.ipk`;
  const ipkPath = path.join(outDir, ipkName);
  const buildDir = path.join(outDir, '.ipk-build');

  fs.mkdirSync(buildDir, {recursive: true});

  try {
    fs.writeFileSync(path.join(buildDir, 'debian-binary'), '2.0\n');
    fs.copyFileSync(dataTarPath, path.join(buildDir, 'data.tar.gz'));
    fs.copyFileSync(controlTarPath, path.join(buildDir, 'control.tar.gz'));
    execSync(
      `COPYFILE_DISABLE=1 tar --format=ustar -czf "${ipkPath}" -C "${buildDir}" ./debian-binary ./data.tar.gz ./control.tar.gz`,
      {stdio: 'inherit'},
    );

    return ipkPath;
  } finally {
    fs.rmSync(buildDir, {recursive: true, force: true});
  }
}

export interface IpkInfo {
  arch: string;
  filename: string;
  size: number;
  sha256: string;
}

export function generateFeed(version: string, ipks: IpkInfo[]): string {
  return ipks.map((ipk) =>
    [
      'Package: mndw',
      `Version: ${version}`,
      'Depends: lighttpd, lighttpd-mod-proxy, lighttpd-mod-rewrite, lighttpd-mod-alias',
      'Section: web',
      `Architecture: ${ipk.arch}`,
      `Filename: ${ipk.filename}`,
      `Size: ${ipk.size}`,
      `SHA256sum: ${ipk.sha256}`,
      'Description: Modular plugin-based dashboard served by lighttpd.',
    ].join('\n')
  ).join('\n\n') + '\n';
}

export function writeFeed(ipkPaths: string[], version: string, repoDir: string): void {
  fs.mkdirSync(repoDir, {recursive: true});

  const ipks: IpkInfo[] = [];

  for (const ipkPath of ipkPaths) {
    const filename = path.basename(ipkPath);
    const archMatch = filename.match(/^mndw_[^_]+_(.+)\.ipk$/);

    if (!archMatch) { throw new Error(`Unexpected ipk filename: ${filename}`); }

    const stat = fs.statSync(ipkPath);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(ipkPath))
      .digest('hex');

    ipks.push({arch: archMatch[1], filename, size: stat.size, sha256});
    fs.copyFileSync(ipkPath, path.join(repoDir, filename));
  }

  const packages = generateFeed(version, ipks);

  fs.writeFileSync(path.join(repoDir, 'Packages'), packages);
  fs.writeFileSync(path.join(repoDir, 'Packages.gz'), zlib.gzipSync(packages));
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
  const result = spawnSync(command, args, {stdio: 'ignore'});

  if (result.error || result.status !== 0) { throw new Error(`Required command not found or failed: ${command}`); }
}

export function ensureBuildPrereqs(repoRoot: string): void {
  requireCommand('go', ['version']);

  const nodeModulesDir = path.join(repoRoot, 'node_modules');

  if (!fs.existsSync(nodeModulesDir)) {
    const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], {cwd: repoRoot, stdio: 'inherit'});

    if (install.error || install.status !== 0) { throw new Error('pnpm install --frozen-lockfile failed'); }
  }

  const hostBuild = spawnSync('pnpm', ['--filter', '@mndw/host', 'build'], {cwd: repoRoot, stdio: 'inherit'});

  if (hostBuild.error || hostBuild.status !== 0) { throw new Error('host build failed'); }

  const pluginBuild = spawnSync('pnpm', ['build-builtin-plugins'], {cwd: repoRoot, stdio: 'inherit'});

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

export function buildOneArch(arch: string, repoRoot: string, version: string): string {
  if (!isProductTarget(arch)) { throw new Error(`Unknown architecture: ${arch}`); }

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

    const dataTarPath = buildDataTar(stagingDir, buildDir);
    const controlTarPath = buildControlTar(path.join(repoRoot, 'build', 'packaging', 'ipk'), buildDir, version, arch);

    return buildIpk(dataTarPath, controlTarPath, outDir, version, arch);
  } finally {
    fs.rmSync(stagingDir, {recursive: true, force: true});
    fs.rmSync(buildDir, {recursive: true, force: true});
    fs.rmSync(artifactRoot, {recursive: true, force: true});
  }
}

export function main(args: string[]): void {
  const {arch, all, repo} = parseArgs(args);
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const version = readVersion(repoRoot);

  ensureBuildPrereqs(repoRoot);

  const arches = all ? [...PRODUCT_TARGETS] : arch === null ? [] : [arch];
  const ipkPaths: string[] = [];

  for (const a of arches) {
    console.log(`Building for ${a}...`);

    const ipkPath = buildOneArch(a, repoRoot, version);

    ipkPaths.push(ipkPath);
    console.log(`  -> ${ipkPath}`);
  }

  if (repo && ipkPaths.length > 0) {
    const repoDir = path.join(repoRoot, 'out', 'repo');

    console.log(`Generating feed at ${repoDir}...`);
    writeFeed(ipkPaths, version, repoDir);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === process.argv[1]) {
  main(process.argv.slice(2));
}
