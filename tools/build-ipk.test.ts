import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execSync} from 'node:child_process';
import zlib from 'node:zlib';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {SHARED_DEPENDENCIES} from '@mndw/sdk/shared-dependencies';
import {
  ARCH_MAP,
  buildControlTar,
  buildIpk,
  collectStagePaths,
  detectTar,
  generateFeed,
  parseArgs,
  readVersion,
  stageDeployFiles,
  substituteControl,
  verifyElfWithExec,
  verifyStage,
} from './build-ipk.js';

const isExecutable = (mode: number): boolean =>
  mode.toString(8).slice(-3)
    .split('')
    .some((digit) => '1357'.includes(digit));

const readTarEntries = (archivePath: string): {name: string; typeFlag: string}[] => {
  const archive = zlib.gunzipSync(fs.readFileSync(archivePath));
  const entries: {name: string; typeFlag: string}[] = [];

  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) { break; }

    const name = header.subarray(0, 100).toString('utf8')
      .replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii')
      .replace(/\0.*$/, '')
      .trim();
    const size = parseInt(sizeText, 8);

    entries.push({name, typeFlag: String.fromCharCode(header[156] || 0)});
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
};

const expectUstarArchive = (archivePath: string): void => {
  const entries = readTarEntries(archivePath);

  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every(({name, typeFlag}) => typeFlag !== 'x' && !name.includes('PaxHeader') && !name.includes('/._')))
    .toBe(true);
};

describe('ARCH_MAP', () => {
  it('maps mipsel-3.4 to mipsle softfloat', () => {
    expect(ARCH_MAP['mipsel-3.4']).toEqual({GOARCH: 'mipsle', GOMIPS: 'softfloat'});
  });

  it('maps aarch64-3.10 to arm64', () => {
    expect(ARCH_MAP['aarch64-3.10']).toEqual({GOARCH: 'arm64'});
  });

  it('maps armv7-3.2 to arm with GOARM 7', () => {
    expect(ARCH_MAP['armv7-3.2']).toEqual({GOARCH: 'arm', GOARM: '7'});
  });

  it('returns undefined for unknown arch', () => {
    expect(ARCH_MAP['x86_64-3.2']).toBeUndefined();
  });
});

describe('detectTar', () => {
  it('returns GNU opts for GNU tar', () => {
    expect(detectTar('GNU tar')).toEqual(['--owner=0', '--group=0', '--numeric-owner']);
  });

  it('returns BSD opts for non-GNU tar', () => {
    expect(detectTar('bsdtar 3.7.1')).toEqual(['--uid=0', '--gid=0', '--uname=root', '--gname=root']);
  });

  it('handles macOS tar', () => {
    expect(detectTar('bsdtar 3.7.1 - libarchive 3.7.1')).toEqual([
      '--uid=0',
      '--gid=0',
      '--uname=root',
      '--gname=root',
    ]);
  });
});

describe('substituteControl', () => {
  const template =
    'Package: mndw\nVersion: __VERSION__\nDepends: lighttpd, lighttpd-mod-proxy, lighttpd-mod-rewrite, lighttpd-mod-alias\nArchitecture: __ARCH__\nDescription: Test\n';

  it('substitutes version and arch', () => {
    const result = substituteControl(template, '1.0.0', 'mipsel-3.4');

    expect(result).toContain('Version: 1.0.0');
    expect(result).toContain('Architecture: mipsel-3.4');
    expect(result).not.toContain('__VERSION__');
    expect(result).not.toContain('__ARCH__');
  });

  it('replaces every placeholder occurrence', () => {
    const result = substituteControl('__VERSION__ __VERSION__ __ARCH__ __ARCH__', '2.0.0', 'armv7-3.2');

    expect(result).toBe('2.0.0 2.0.0 armv7-3.2 armv7-3.2');
  });
});

describe('collectStagePaths', () => {
  it('returns all required staging keys', () => {
    const paths = collectStagePaths();

    expect(paths.mndwd).toBe(path.join('opt', 'sbin', 'mndwd'));
    expect(paths.indexHtml).toBe(path.join('opt', 'share', 'www', 'mndw', 'index.html'));
    expect(paths.assets).toBe(path.join('opt', 'share', 'www', 'mndw', 'assets'));
    expect(paths.lighttpdConf).toBe(path.join('opt', 'etc', 'lighttpd', 'conf.d', '80-mndw.conf'));
    expect(paths.initScript).toBe(path.join('opt', 'etc', 'init.d', 'S70mndwd'));
    expect(paths.moduleGuard).toBe(path.join('opt', 'share', 'www', 'mndw', 'bin', 'mndw-load-modules.sh'));
  });
});

describe('verifyStage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  const stageFile = (p: string, content = ''): void => {
    const full = path.join(tmpDir, p);

    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, content);
  };

  const stageDir = (p: string): void => {
    fs.mkdirSync(path.join(tmpDir, p), {recursive: true});
  };

  const stageRequired = (): void => {
    stageFile('opt/sbin/mndwd');
    stageFile('opt/share/www/mndw/index.html');
    stageDir('opt/share/www/mndw/assets');

    for (const entry of SHARED_DEPENDENCIES) {
      stageFile(path.join('opt', 'share', 'www', 'mndw', 'shared', `${entry.bundle}@${entry.version}.js`));
    }

    stageFile('opt/etc/lighttpd/conf.d/80-mndw.conf');
    stageFile('opt/etc/init.d/S70mndwd');
    stageFile('opt/share/www/mndw/bin/mndw-load-modules.sh');
  };

  it('passes when all required files exist', () => {
    stageRequired();
    stageFile('opt/share/www/mndw/plugins/some-plugin/manifest.json');
    expect(() => verifyStage(tmpDir)).not.toThrow();
  });

  it('throws when daemon binary is missing', () => {
    expect(() => verifyStage(tmpDir)).toThrow('Missing');
  });

  it('throws when index.html is missing', () => {
    stageRequired();
    fs.rmSync(path.join(tmpDir, 'opt/share/www/mndw/index.html'));
    stageFile('opt/share/www/mndw/plugins/some-plugin/manifest.json');
    expect(() => verifyStage(tmpDir)).toThrow('Missing');
  });

  it('throws when a required shared bundle is missing', () => {
    stageRequired();
    fs.rmSync(path.join(tmpDir, 'opt/share/www/mndw/shared/rxjs@7.8.2.js'));
    stageFile('opt/share/www/mndw/plugins/some-plugin/manifest.json');
    expect(() => verifyStage(tmpDir)).toThrow('Missing');
  });

  it('throws when builtin plugins directory is empty', () => {
    stageRequired();
    stageDir('opt/share/www/mndw/plugins');
    expect(() => verifyStage(tmpDir)).toThrow('builtin plugins');
  });
});

describe('readVersion', () => {
  it('reads version from root package.json', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const version = readVersion(repoRoot);

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('generateFeed', () => {
  it('generates Packages with correct stanza for one arch', () => {
    const ipks = [{
      arch: 'mipsel-3.4',
      filename: 'mndw_0.1.0_mipsel-3.4.ipk',
      size: 12345,
      sha256: 'abc123',
    }];
    const packages = generateFeed('0.1.0', ipks);

    expect(packages).toContain('Package: mndw');
    expect(packages).toContain('Version: 0.1.0');
    expect(packages).toContain('Architecture: mipsel-3.4');
    expect(packages).toContain('Filename: mndw_0.1.0_mipsel-3.4.ipk');
    expect(packages).toContain('Size: 12345');
    expect(packages).toContain('SHA256sum: abc123');
    expect(packages).toContain('Depends: lighttpd, lighttpd-mod-proxy, lighttpd-mod-rewrite, lighttpd-mod-alias');
  });

  it('generates Packages with multiple stanzas for multiple arches', () => {
    const ipks = [
      {arch: 'mipsel-3.4', filename: 'mndw_0.1.0_mipsel-3.4.ipk', size: 100, sha256: 'aaa'},
      {arch: 'aarch64-3.10', filename: 'mndw_0.1.0_aarch64-3.10.ipk', size: 200, sha256: 'bbb'},
    ];
    const packages = generateFeed('0.1.0', ipks);
    const count = (packages.match(/^Package: mndw$/gm) || []).length;

    expect(count).toBe(2);
  });

  it('generates distinct sha256 per arch', () => {
    const ipks = [
      {arch: 'mipsel-3.4', filename: 'a.ipk', size: 100, sha256: 'aaa'},
      {arch: 'aarch64-3.10', filename: 'b.ipk', size: 200, sha256: 'bbb'},
    ];
    const packages = generateFeed('0.1.0', ipks);

    expect(packages).toContain('SHA256sum: aaa');
    expect(packages).toContain('SHA256sum: bbb');
  });
});

describe('verifyElf', () => {
  it('rejects aarch64 binary passed as armv7 target', () => {
    const fakeExec = (): string => 'ELF 64-bit LSB executable, ARM aarch64';

    expect(() => verifyElfWithExec('/fake/path', 'armv7-3.2', fakeExec)).toThrow('does not match target');
  });

  it('accepts valid armv7 binary', () => {
    const fakeExec = (): string => 'ELF 32-bit LSB executable, ARM, EABI5 version 1 (SYSV)';

    expect(() => verifyElfWithExec('/fake/path', 'armv7-3.2', fakeExec)).not.toThrow();
  });
});

describe('buildControlTar', () => {
  const writeControlFixture = (dir: string, includePostinst = true): void => {
    fs.writeFileSync(
      path.join(dir, 'control'),
      'Package: test\nVersion: 1.0.0\nDepends: test\nArchitecture: all\nDescription: test\n',
    );
    fs.writeFileSync(path.join(dir, 'conffiles'), '');
    fs.writeFileSync(path.join(dir, 'preinst'), '#!/bin/sh\nexit 0\n');

    if (includePostinst) { fs.writeFileSync(path.join(dir, 'postinst'), '#!/bin/sh\nexit 0\n'); }

    fs.writeFileSync(path.join(dir, 'prerm'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(dir, 'postrm'), '#!/bin/sh\nexit 0\n');
  };

  it('throws when a required control file is missing', () => {
    const tmpIpk = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-ctrl-test-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-ctrl-out-'));

    try {
      writeControlFixture(tmpIpk, false);
      expect(() => buildControlTar(tmpIpk, outDir, '1.0.0', 'all')).toThrow('Missing required ipk control file');
    } finally {
      fs.rmSync(tmpIpk, {recursive: true, force: true});
      fs.rmSync(outDir, {recursive: true, force: true});
    }
  });

  it('produces control.tar.gz with all members and executable scripts', () => {
    const tmpIpk = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-ctrl-ok-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-ctrl-out2-'));

    try {
      writeControlFixture(tmpIpk);

      const tarPath = buildControlTar(tmpIpk, outDir, '1.0.0', 'all');

      expect(fs.existsSync(tarPath)).toBe(true);

      const listing = execSync(`tar -tzf "${tarPath}"`, {encoding: 'utf8'}).trim()
        .split('\n');

      for (const member of ['control', 'conffiles', 'preinst', 'postinst', 'prerm', 'postrm']) {
        expect(listing).toContain(`./${member}`);
      }

      execSync(`tar -xzf "${tarPath}" -C "${outDir}"`, {encoding: 'utf8'});

      for (const script of ['preinst', 'postinst', 'prerm', 'postrm']) {
        const mode = fs.statSync(path.join(outDir, script)).mode;

        expect(isExecutable(mode)).toBe(true);
      }

      expectUstarArchive(tarPath);
    } finally {
      fs.rmSync(tmpIpk, {recursive: true, force: true});
      fs.rmSync(outDir, {recursive: true, force: true});
    }
  });
});

describe('buildIpk', () => {
  it('produces an outer USTAR archive without macOS metadata', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-out-'));

    try {
      const dataTarPath = path.join(outDir, 'data.tar.gz');
      const controlTarPath = path.join(outDir, 'control.tar.gz');

      fs.writeFileSync(dataTarPath, zlib.gzipSync('data'));
      fs.writeFileSync(controlTarPath, zlib.gzipSync('control'));

      const ipkPath = buildIpk(dataTarPath, controlTarPath, outDir, '1.0.0', 'all');

      expectUstarArchive(ipkPath);
    } finally {
      fs.rmSync(outDir, {recursive: true, force: true});
    }
  });
});

describe('stageDeployFiles', () => {
  it('copies lighttpd conf, init script, module guard to staging', () => {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-stage-test-'));

    try {
      const repoRoot = path.resolve(import.meta.dirname, '..');

      stageDeployFiles(repoRoot, stagingDir);

      const initPath = path.join(stagingDir, 'opt', 'etc', 'init.d', 'S70mndwd');

      expect(fs.existsSync(initPath)).toBe(true);
      expect(isExecutable(fs.statSync(initPath).mode)).toBe(true);

      const guardPath = path.join(stagingDir, 'opt', 'share', 'www', 'mndw', 'bin', 'mndw-load-modules.sh');

      expect(fs.existsSync(guardPath)).toBe(true);
      expect(isExecutable(fs.statSync(guardPath).mode)).toBe(true);

      const confPath = path.join(stagingDir, 'opt', 'etc', 'lighttpd', 'conf.d', '80-mndw.conf');

      expect(fs.existsSync(confPath)).toBe(true);

      const confContent = fs.readFileSync(confPath, 'utf8');

      expect(confContent).toContain('include_shell');
      expect(confContent).toContain('upgrade');
    } finally {
      fs.rmSync(stagingDir, {recursive: true, force: true});
    }
  });

  it('keeps persistent-session ciphertext and key paths separate across lifecycle scripts', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const init = fs.readFileSync(path.join(repoRoot, 'deploy', 'init', 'S70mndwd'), 'utf8');
    const postrm = fs.readFileSync(path.join(repoRoot, 'deploy', 'ipk', 'postrm'), 'utf8');

    expect(init).toContain('KEY_DIR="/opt/var/lib/mndw-secrets"');
    expect(init).toContain('chmod 700 "$DATA_DIR" "$KEY_DIR" "$PLUGIN_RUNTIME_DIR"');
    expect(init).toContain('--rci-session-state-dir "$DATA_DIR"');
    expect(init).toContain('--rci-session-key-dir "$KEY_DIR"');
    expect(postrm).not.toContain('rm -rf /opt/var/lib/mndw-secrets');
    expect(postrm).not.toContain('rm -rf "$KEY_DIR"');
  });
});

describe('parseArgs', () => {
  it('parses --arch', () => {
    expect(parseArgs(['--arch', 'mipsel-3.4']).arch).toBe('mipsel-3.4');
  });

  it('parses --all', () => {
    expect(parseArgs(['--all']).all).toBe(true);
  });

  it('parses --repo', () => {
    expect(parseArgs(['--arch', 'aarch64-3.10', '--repo']).repo).toBe(true);
  });

  it('requires --arch or --all', () => {
    expect(() => parseArgs([])).toThrow('must specify --arch or --all');
  });

  it('rejects unknown arch', () => {
    expect(() => parseArgs(['--arch', 'bad-arch'])).toThrow('Unknown architecture');
  });

  it('rejects missing value for --arch', () => {
    expect(() => parseArgs(['--arch'])).toThrow('Missing value for --arch');
  });
});
