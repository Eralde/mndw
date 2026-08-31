import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import zlib from 'node:zlib';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {SHARED_DEPENDENCIES} from '@mndw/sdk/shared-dependencies';
import {
  ARCH_MAP,
  buildControlTar,
  buildDataTar,
  buildIpk,
  collectStagePaths,
  generateFeed,
  isMainModule,
  opkgArchForTarget,
  parseArgs,
  readVersion,
  stageDeployFiles,
  substituteControl,
  verifyElfBytes,
  verifyStage,
  writeFeed,
} from './build-ipk.js';

const isExecutable = (mode: number): boolean => {
  return mode.toString(8).slice(-3)
    .split('')
    .some((digit) => '1357'.includes(digit));
};

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

const readTarFile = (archivePath: string, wantedName: string): Buffer => {
  const archive = zlib.gunzipSync(fs.readFileSync(archivePath));

  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) { break; }

    const name = header.subarray(0, 100).toString('utf8')
.replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii')
.replace(/\0.*$/, '')
.trim();
    const size = parseInt(sizeText || '0', 8);
    const contentOffset = offset + 512;

    if (name === wantedName) { return archive.subarray(contentOffset, contentOffset + size); }

    offset = contentOffset + Math.ceil(size / 512) * 512;
  }

  throw new Error(`missing tar member: ${wantedName}`);
};

interface TarHeaderDetail {
  name: string;
  typeFlag: string;
  mode: string;
  uid: number;
  uname: string;
}

const octalField = (buf: Buffer): string => {
  return buf.toString('ascii')
    .replace(/\0.*$/, '')
    .trim();
};

const readTarHeaders = (archivePath: string): TarHeaderDetail[] => {
  const archive = zlib.gunzipSync(fs.readFileSync(archivePath));
  const headers: TarHeaderDetail[] = [];

  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) { break; }

    const name = header.subarray(0, 100).toString('utf8')
      .replace(/\0.*$/, '');
    const size = parseInt(octalField(header.subarray(124, 136)) || '0', 8);
    const mode = octalField(header.subarray(100, 108)).slice(-3);
    const uid = parseInt(octalField(header.subarray(108, 116)) || '0', 8);
    const uname = header.subarray(265, 297).toString('utf8')
      .replace(/\0.*$/, '');

    headers.push({name, typeFlag: String.fromCharCode(header[156] || 0), mode, uid, uname});
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return headers;
};

const expectUstarArchive = (archivePath: string): void => {
  const entries = readTarEntries(archivePath);

  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every(({name, typeFlag}) => typeFlag !== 'x' && !name.includes('PaxHeader') && !name.includes('/._')))
    .toBe(true);
};

describe('ARCH_MAP', () => {
  it('maps mipsel to mipsle softfloat', () => {
    expect(ARCH_MAP.mipsel).toEqual({GOARCH: 'mipsle', GOMIPS: 'softfloat'});
  });

  it('maps aarch64 to arm64', () => {
    expect(ARCH_MAP.aarch64).toEqual({GOARCH: 'arm64'});
  });

  it('maps mips to big-endian softfloat MIPS', () => {
    expect(ARCH_MAP.mips).toEqual({GOARCH: 'mips', GOMIPS: 'softfloat'});
  });

  it('returns undefined for unknown arch', () => {
    expect((ARCH_MAP as Record<string, unknown>)['legacy-target']).toBeUndefined();
  });
});

describe('IPK target package surfaces', () => {
  it('maps bare targets to kernel-suffixed opkg architectures', () => {
    expect(opkgArchForTarget('aarch64')).toBe('aarch64-3.10');
    expect(opkgArchForTarget('mips')).toBe('mips-3.4');
    expect(opkgArchForTarget('mipsel')).toBe('mipsel-3.4');
  });
});

describe('substituteControl', () => {
  const template = 'Package: mndw\nVersion: __VERSION__\nArchitecture: __ARCH__\nDescription: Test\n';

  it('substitutes version and arch', () => {
    const result = substituteControl(template, '1.0.0', 'mipsel-3.4');

    expect(result).toContain('Version: 1.0.0');
    expect(result).toContain('Architecture: mipsel-3.4');
    expect(result).not.toContain('__VERSION__');
    expect(result).not.toContain('__ARCH__');
  });

  it('replaces every placeholder occurrence', () => {
    const result = substituteControl('__VERSION__ __VERSION__ __ARCH__ __ARCH__', '2.0.0', 'aarch64-3.10');

    expect(result).toBe('2.0.0 2.0.0 aarch64-3.10 aarch64-3.10');
  });
});

describe('collectStagePaths', () => {
  it('returns all required staging keys', () => {
    const paths = collectStagePaths();

    expect(paths.mndwd).toBe(path.join('opt', 'sbin', 'mndwd'));
    expect(paths.indexHtml).toBe(path.join('opt', 'share', 'www', 'mndw', 'index.html'));
    expect(paths.assets).toBe(path.join('opt', 'share', 'www', 'mndw', 'assets'));
    expect(paths.initScript).toBe(path.join('opt', 'etc', 'init.d', 'S70mndwd'));
    expect(paths.devicePortHelper).toBe(path.join('opt', 'share', 'www', 'mndw', 'bin', 'mndw-device-port.sh'));
    expect(paths.daemonConfig).toBe(path.join('opt', 'etc', 'mndw.conf'));
    expect(paths.selfUpdateHelper).toBe(
      path.join('opt', 'share', 'www', 'mndw', 'bin', 'mndw-self-update.sh'),
    );
  });
});

describe('writeFeed', () => {
  it('writes isolated per-arch feed directories', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-feed-'));
    const ipkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipks-'));
    const ipks = ['aarch64-3.10', 'mips-3.4', 'mipsel-3.4'].map((arch) => {
      const file = path.join(ipkDir, `mndw_0.0.4_${arch}.ipk`);

      fs.writeFileSync(file, arch);

      return file;
    });

    writeFeed(ipks, '0.0.4', repoDir);

    for (const arch of ['aarch64-3.10', 'mips-3.4', 'mipsel-3.4']) {
      const packages = fs.readFileSync(path.join(repoDir, arch, 'Packages'), 'utf8');

      expect(packages.match(/^Package: mndw$/gm)).toHaveLength(1);
      expect(packages).toContain(`Architecture: ${arch}`);
      expect(packages).toContain(`Filename: mndw_0.0.4_${arch}.ipk`);
      expect(fs.existsSync(path.join(repoDir, arch, 'Packages.gz'))).toBe(true);
      expect(fs.existsSync(path.join(repoDir, arch, `mndw_0.0.4_${arch}.ipk`))).toBe(true);
    }

    expect(fs.existsSync(path.join(repoDir, 'Packages'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'Packages.gz'))).toBe(false);
  });

  it('removes stale managed feed output only after validating all inputs', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-feed-stale-'));
    const ipkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipks-stale-'));
    const valid = path.join(ipkDir, 'mndw_0.0.4_mips-3.4.ipk');
    const invalid = path.join(ipkDir, 'mndw_0.0.4_unknown.ipk');

    fs.writeFileSync(path.join(repoDir, 'Packages'), 'old root index');
    fs.mkdirSync(path.join(repoDir, 'mipsel-3.4'), {recursive: true});
    fs.writeFileSync(path.join(repoDir, 'mipsel-3.4', 'stale.ipk'), 'stale');
    fs.writeFileSync(valid, 'valid');
    fs.writeFileSync(invalid, 'invalid');

    expect(() => writeFeed([valid, invalid], '0.0.4', repoDir)).toThrow('Unexpected ipk filename');
    expect(fs.readFileSync(path.join(repoDir, 'Packages'), 'utf8')).toBe('old root index');
    expect(fs.existsSync(path.join(repoDir, 'mipsel-3.4', 'stale.ipk'))).toBe(true);

    writeFeed([valid], '0.0.4', repoDir);

    expect(fs.existsSync(path.join(repoDir, 'Packages'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'mipsel-3.4'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'mips-3.4', 'mndw_0.0.4_mips-3.4.ipk'))).toBe(true);
  });

  it('rejects duplicate architectures before mutating output', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-feed-duplicates-'));
    const ipkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipks-duplicates-'));
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipks-duplicates-2-'));
    const first = path.join(ipkDir, 'mndw_0.0.4_mips-3.4.ipk');
    const second = path.join(secondDir, 'mndw_0.0.4_mips-3.4.ipk');

    fs.writeFileSync(path.join(repoDir, 'Packages'), 'preserved');
    fs.writeFileSync(first, 'first');
    fs.writeFileSync(second, 'second');

    expect(() => writeFeed([first, second], '0.0.4', repoDir)).toThrow('Duplicate architecture');
    expect(fs.readFileSync(path.join(repoDir, 'Packages'), 'utf8')).toBe('preserved');
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

    stageFile('opt/etc/init.d/S70mndwd');
    stageFile('opt/share/www/mndw/bin/mndw-device-port.sh');
    stageFile('opt/share/www/mndw/bin/mndw-self-update.sh');
    stageFile('opt/etc/mndw.conf');
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
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
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
    expect(packages).not.toContain('lighttpd');
    expect(packages).toContain('Description: Modular plugin-based dashboard served by mndwd.');
  });

  it('generates Packages with multiple stanzas for multiple arches', () => {
    const ipks = [
      {arch: 'mipsel-3.4', filename: 'mndw_0.1.0_mipsel-3.4.ipk', size: 100, sha256: 'aaa'},
      {arch: 'aarch64-3.10', filename: 'mndw_0.1.0_aarch64-3.10.ipk', size: 200, sha256: 'bbb'},
      {arch: 'mips-3.4', filename: 'mndw_0.1.0_mips-3.4.ipk', size: 300, sha256: 'ccc'},
    ];
    const packages = generateFeed('0.1.0', ipks);
    const count = (packages.match(/^Package: mndw$/gm) || []).length;

    expect(count).toBe(3);
    expect(packages).toContain('Architecture: mips-3.4');
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
  const header = (target: 'aarch64' | 'mips' | 'mipsel', machine = target === 'aarch64' ? 183 : 8): Uint8Array => {
    const bytes = new Uint8Array(target === 'aarch64' ? 64 : 52);

    bytes.set([0x7f, 0x45, 0x4c, 0x46, target === 'aarch64' ? 2 : 1, target === 'mips' ? 2 : 1], 0);

    const view = new DataView(bytes.buffer);

    view.setUint16(18, machine, target !== 'mips');

    return bytes;
  };

  it('accepts the expected ELF class, machine, and byte order', () => {
    expect(() => verifyElfBytes(header('aarch64'), 'aarch64')).not.toThrow();
    expect(() => verifyElfBytes(header('mips'), 'mips')).not.toThrow();
    expect(() => verifyElfBytes(header('mipsel'), 'mipsel')).not.toThrow();
  });

  it('rejects little-endian MIPS presented as big-endian mips', () => {
    expect(() => verifyElfBytes(header('mipsel'), 'mips')).toThrow('byte order');
  });

  it('rejects malformed, wrong-class, and wrong-machine ELF headers', () => {
    expect(() => verifyElfBytes(new Uint8Array([0x7f, 0x45]), 'mips')).toThrow('truncated');
    expect(() => verifyElfBytes(header('aarch64').map((byte, index) => index === 4 ? 1 : byte), 'aarch64'))
      .toThrow('class');
    expect(() => verifyElfBytes(header('mips', 183), 'mips')).toThrow('machine');
  });
});

describe('buildDataTar', () => {
  let stagingDir: string;
  let outDir: string;

  beforeEach(() => {
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-data-stage-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-data-out-'));
  });

  afterEach(() => {
    fs.rmSync(stagingDir, {recursive: true, force: true});
    fs.rmSync(outDir, {recursive: true, force: true});
  });

  const stage = (rel: string, mode: number, content = ''): void => {
    const full = path.join(stagingDir, rel);

    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, content);
    fs.chmodSync(full, mode);
  };

  it('assigns file modes and root ownership from policy, not from on-disk perms', async () => {
    // Deliberately stage everything non-executable / mode 0644 on disk; the archive
    // modes must come from policy so they are correct even on hosts where chmod is a no-op.
    stage('opt/etc/init.d/S70mndwd', 0o644, '#!/bin/sh\n');
    stage('opt/share/www/mndw/bin/mndw-device-port.sh', 0o644, '#!/bin/sh\n');
    stage('opt/sbin/mndwd', 0o644, '\x7fELF');
    stage('opt/share/www/mndw/plugins/p/backend/p', 0o644, '\x7fELF');
    stage('opt/etc/mndw.conf', 0o644, 'key=value\n');
    stage('opt/share/www/mndw/index.html', 0o644, '<html>');

    const tarPath = await buildDataTar(stagingDir, outDir);
    const byName = new Map(readTarHeaders(tarPath).map((h) => [h.name, h]));
    const modeOf = (rel: string): string | undefined => byName.get(`./${rel}`)?.mode;

    expect(modeOf('opt/etc/init.d/S70mndwd')).toBe('755');
    expect(modeOf('opt/share/www/mndw/bin/mndw-device-port.sh')).toBe('755');
    expect(modeOf('opt/sbin/mndwd')).toBe('755');
    expect(modeOf('opt/share/www/mndw/plugins/p/backend/p')).toBe('755');
    expect(modeOf('opt/etc/mndw.conf')).toBe('600');
    expect(modeOf('opt/share/www/mndw/index.html')).toBe('644');

    for (const header of byName.values()) {
      expect(header.uid).toBe(0);
      expect(header.uname).toBe('root');
    }
  });

  it('emits directory entries for every parent, ordered before their contents', async () => {
    stage('opt/share/www/mndw/index.html', 0o644, '<html>');
    stage('opt/etc/mndw.conf', 0o644, 'k=v\n');

    const headers = await buildDataTar(stagingDir, outDir).then(readTarHeaders);
    const dirs = headers.filter((h) => h.typeFlag === '5').map((h) => h.name);

    // BusyBox tar (opkg's extractor) does not create parent dirs implicitly.
    for (const dir of ['./opt/', './opt/share/', './opt/share/www/', './opt/share/www/mndw/', './opt/etc/']) {
      expect(dirs).toContain(dir);
    }

    const indexOf = (name: string): number => headers.findIndex((h) => h.name === name);

    expect(indexOf('./opt/share/www/mndw/')).toBeLessThan(indexOf('./opt/share/www/mndw/index.html'));
    expect(indexOf('./opt/etc/')).toBeLessThan(indexOf('./opt/etc/mndw.conf'));

    for (const dir of dirs) {
      const header = headers.find((h) => h.name === dir);

      expect(header?.mode).toBe('755');
      expect(header?.uname).toBe('root');
    }
  });

  it('excludes macOS metadata files from the archive', async () => {
    stage('opt/share/www/mndw/index.html', 0o644, '<html>');
    stage('opt/share/www/mndw/._index.html', 0o644, 'junk');
    stage('opt/share/www/mndw/.DS_Store', 0o644, 'junk');

    const names = await buildDataTar(stagingDir, outDir).then(readTarHeaders)
      .then((hs) => hs.map((h) => h.name));

    expect(names).toContain('./opt/share/www/mndw/index.html');
    expect(names.some((n) => n.includes('._') || n.includes('.DS_Store'))).toBe(false);
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

  it('throws when a required control file is missing', async () => {
    const tmpIpk = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-ctrl-test-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-ctrl-out-'));

    try {
      writeControlFixture(tmpIpk, false);
      await expect(buildControlTar(tmpIpk, outDir, '1.0.0', 'all')).rejects.toThrow(
        'Missing required ipk control file',
      );
    } finally {
      fs.rmSync(tmpIpk, {recursive: true, force: true});
      fs.rmSync(outDir, {recursive: true, force: true});
    }
  });

  it('produces control.tar.gz with all members, executable scripts, and root ownership', async () => {
    const tmpIpk = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-ctrl-ok-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-ctrl-out2-'));

    try {
      writeControlFixture(tmpIpk);

      // Scripts are written non-executable on disk; the archive header modes must still be 0755.
      for (const script of ['preinst', 'postinst', 'prerm', 'postrm']) {
        fs.chmodSync(path.join(tmpIpk, script), 0o644);
      }

      const tarPath = await buildControlTar(tmpIpk, outDir, '1.0.0', 'all');

      expect(fs.existsSync(tarPath)).toBe(true);

      const byName = new Map(readTarHeaders(tarPath).map((h) => [h.name, h]));

      for (const member of ['control', 'conffiles', 'preinst', 'postinst', 'prerm', 'postrm']) {
        expect(byName.has(`./${member}`)).toBe(true);
      }

      for (const script of ['preinst', 'postinst', 'prerm', 'postrm']) {
        expect(byName.get(`./${script}`)?.mode).toBe('755');
      }

      expect(byName.get('./control')?.mode).toBe('644');
      expect(byName.get('./conffiles')?.mode).toBe('644');

      for (const header of byName.values()) {
        expect(header.uid).toBe(0);
        expect(header.uname).toBe('root');
      }

      expectUstarArchive(tarPath);
    } finally {
      fs.rmSync(tmpIpk, {recursive: true, force: true});
      fs.rmSync(outDir, {recursive: true, force: true});
    }
  });

  it('substitutes arch in archived postinst', async () => {
    const tmpIpk = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-postinst-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-postinst-out-'));

    try {
      writeControlFixture(tmpIpk);
      fs.writeFileSync(
        path.join(tmpIpk, 'postinst'),
        '#!/bin/sh\necho https://eralde.github.io/mndw-opkg-feed/__ARCH__\n',
      );

      const archive = await buildControlTar(tmpIpk, outDir, '0.0.4', 'mipsel-3.4');
      const postinst = readTarFile(archive, './postinst').toString('utf8');

      expect(postinst).toContain('mndw-opkg-feed/mipsel-3.4');
      expect(postinst).not.toContain('__ARCH__');
    } finally {
      fs.rmSync(tmpIpk, {recursive: true, force: true});
      fs.rmSync(outDir, {recursive: true, force: true});
    }
  });
});

describe('buildIpk', () => {
  it('produces an outer USTAR archive with the three ar members', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-ipk-out-'));

    try {
      const dataTarPath = path.join(outDir, 'data.tar.gz');
      const controlTarPath = path.join(outDir, 'control.tar.gz');

      fs.writeFileSync(dataTarPath, zlib.gzipSync('data'));
      fs.writeFileSync(controlTarPath, zlib.gzipSync('control'));

      const ipkPath = await buildIpk(dataTarPath, controlTarPath, outDir, '1.0.0', 'all');

      expectUstarArchive(ipkPath);

      const names = readTarHeaders(ipkPath).map((h) => h.name);

      expect(names).toEqual(['./debian-binary', './data.tar.gz', './control.tar.gz']);
    } finally {
      fs.rmSync(outDir, {recursive: true, force: true});
    }
  });
});

describe('stageDeployFiles', () => {
  it('copies front-door init/config/helper files and no lighttpd files to staging', () => {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-stage-test-'));

    try {
      const repoRoot = path.resolve(import.meta.dirname, '..', '..');

      stageDeployFiles(repoRoot, stagingDir);

      const initPath = path.join(stagingDir, 'opt', 'etc', 'init.d', 'S70mndwd');

      expect(fs.existsSync(initPath)).toBe(true);
      expect(isExecutable(fs.statSync(initPath).mode)).toBe(true);

      expect(fs.existsSync(path.join(stagingDir, 'opt', 'etc', 'mndw.conf'))).toBe(true);

      const devicePortHelperPath = path.join(
        stagingDir,
        'opt',
        'share',
        'www',
        'mndw',
        'bin',
        'mndw-device-port.sh',
      );

      expect(fs.statSync(devicePortHelperPath).mode.toString(8).slice(-3)).toBe('755');
      expect(fs.readFileSync(devicePortHelperPath, 'utf8')).toContain('WWW-Authenticate');

      const selfUpdateHelperPath = path.join(
        stagingDir,
        'opt',
        'share',
        'www',
        'mndw',
        'bin',
        'mndw-self-update.sh',
      );

      expect(fs.statSync(selfUpdateHelperPath).mode.toString(8).slice(-3)).toBe('755');

      const stagedFiles = fs.readdirSync(path.join(stagingDir, 'opt', 'share', 'www', 'mndw', 'bin'));

      expect(stagedFiles.some((file) => file.includes('lighttpd'))).toBe(false);
      expect(fs.existsSync(path.join(stagingDir, 'opt', 'etc', 'lighttpd'))).toBe(false);
    } finally {
      fs.rmSync(stagingDir, {recursive: true, force: true});
    }
  });

  it('keeps persistent-session ciphertext and key paths separate across lifecycle scripts', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const init = fs.readFileSync(path.join(repoRoot, 'build', 'packaging', 'init', 'S70mndwd'), 'utf8');
    const postrm = fs.readFileSync(path.join(repoRoot, 'build', 'packaging', 'ipk', 'postrm'), 'utf8');

    expect(init).toContain('KEY_DIR="$MNDW_ROOT/var/lib/mndw-secrets"');
    expect(init).toContain('chmod 700 "$DATA_DIR" "$KEY_DIR" "$PLUGIN_RUNTIME_DIR"');
    expect(init).toContain('--rci-session-state-dir "$DATA_DIR"');
    expect(init).toContain('--rci-session-key-dir "$KEY_DIR"');
    expect(postrm).not.toContain('rm -rf /opt/var/lib/mndw-secrets');
    expect(postrm).not.toContain('rm -rf "$KEY_DIR"');
  });

  it('passes the durable user-plugin root to mndwd', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const init = fs.readFileSync(path.join(repoRoot, 'build', 'packaging', 'init', 'S70mndwd'), 'utf8');

    expect(init).toContain(': "${MNDW_USER_PLUGINS_DIR:=$DATA_DIR/user-plugins}"');
    expect(init).toContain('export MNDW_USER_PLUGINS_DIR');
    expect(init).toContain('--user-plugins-dir "$MNDW_USER_PLUGINS_DIR"');
    expect(init).not.toContain('--user-plugins-dir "/opt/share/www/mndw/user-plugins"');
  });
});

describe('parseArgs', () => {
  it('parses --arch', () => {
    expect(parseArgs(['--arch', 'mipsel']).arch).toBe('mipsel');
  });

  it('parses --all', () => {
    expect(parseArgs(['--all']).all).toBe(true);
  });

  it('parses --repo', () => {
    expect(parseArgs(['--arch', 'aarch64', '--repo']).repo).toBe(true);
  });

  it('requires --arch or --all', () => {
    expect(() => parseArgs([])).toThrow('must specify --arch or --all');
  });

  it('rejects unknown arch', () => {
    expect(() => parseArgs(['--arch', 'bad-arch'])).toThrow('Unknown architecture');
    expect(() => parseArgs(['--arch', 'mipsel-3.4'])).toThrow('Unknown architecture');
  });

  it('rejects missing value for --arch', () => {
    expect(() => parseArgs(['--arch'])).toThrow('Missing value for --arch');
  });
});

describe('isMainModule', () => {
  it('recognizes a platform-native script path as the module URL', () => {
    const scriptPath = path.resolve('build/packaging/build-ipk.ts');

    expect(isMainModule(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    expect(isMainModule(pathToFileURL(path.resolve('build/index.ts')).href, scriptPath)).toBe(false);
  });
});
