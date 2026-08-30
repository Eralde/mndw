import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const feedRoot = path.join(repoRoot, 'build', 'packaging', 'feed');
const addRepoSource = path.join(feedRoot, 'add_repo.sh');
const installSource = path.join(repoRoot, 'build', 'packaging', 'install.sh');
const publishWorkflow = path.join(repoRoot, '.github', 'workflows', 'publish-opkg-feed.yml');
const fixtures: string[] = [];

const makeFixture = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-feed-assets-'));

  fixtures.push(root);

  return root;
};

const writeExecutable = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
};

const substituteKeyId = (root: string, keyId: string): string => {
  const script = path.join(root, 'add_repo.sh');

  fs.writeFileSync(script, fs.readFileSync(addRepoSource, 'utf8').replaceAll('__FEED_KEY_ID__', keyId));
  fs.chmodSync(script, 0o755);

  return script;
};

const runBootstrap = (script: string, root: string, extraEnv: NodeJS.ProcessEnv = {}) =>
  spawnSync(
    '/bin/sh',
    [script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: path.join(root, 'bin') + ':' + (process.env.PATH ?? ''),
        MNDW_OPKG_CONF_DIR: path.join(root, 'etc', 'opkg'),
        MNDW_OPKG_CACHE_DIR: path.join(root, 'var', 'mndw', 'opkg-cache'),
        MNDW_KEY_DIR: path.join(root, 'etc', 'opkg', 'keys'),
        MNDW_FEED_URL: 'https://feed.example.test/mndw',
        ...extraEnv,
      },
    },
  );

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

describe('hosted feed bootstrap assets', () => {
  it('detects supported architecture, fetches key, writes config once, then updates and installs', () => {
    const root = makeFixture();
    const opkgLog = path.join(root, 'opkg.log');
    const fetchedKey = path.join(root, 'fetched-key');
    const fakeBin = path.join(root, 'bin');

    writeExecutable(
      path.join(fakeBin, 'opkg'),
      '#!/bin/sh\nset -eu\ncase "$1" in\n'
        + '  print-architecture)\n'
        + '    echo "arch all 100"\n'
        + '    echo "arch aarch64-3.10 150"\n'
        + '    echo "arch aarch64-3.10_kn 200"\n'
        + '    ;;\n'
        + '  update|install)\n'
        + '    printf "%s\\n" "$*" >> "$FAKE_OPKG_LOG"\n'
        + '    ;;\n'
        + '  *) exit 1 ;;\n'
        + 'esac\n',
    );
    writeExecutable(
      path.join(fakeBin, 'fetch-key'),
      '#!/bin/sh\nset -eu\n'
        + 'echo "$*" >> "$FAKE_FETCH_LOG"\n'
        + 'printf "%s\\n" "public-key"\n',
    );

    const script = substituteKeyId(root, 'TESTKEY');
    const first = runBootstrap(script, root, {
      FAKE_OPKG_LOG: opkgLog,
      FAKE_FETCH_LOG: fetchedKey,
      MNDW_FETCH: 'fetch-key',
    });
    const config = path.join(root, 'etc', 'opkg', 'mndw-feed.conf');
    const key = path.join(root, 'etc', 'opkg', 'keys', 'TESTKEY.pub');

    expect(first.status, String(first.stdout) + '\n' + String(first.stderr)).toBe(0);
    expect(fs.readFileSync(key, 'utf8')).toBe('public-key\n');
    expect(fs.readFileSync(config, 'utf8')).toBe(
      'src/gz mndw https://feed.example.test/mndw/aarch64-3.10\n'
        + 'option cache ' + path.join(root, 'var', 'mndw', 'opkg-cache') + '\n',
    );
    expect(fs.readFileSync(opkgLog, 'utf8')).toBe('update\ninstall mndw\n');
    expect(fs.readFileSync(fetchedKey, 'utf8')).toContain('https://feed.example.test/mndw/TESTKEY.pub');
    expect(fs.readFileSync(config, 'utf8')).not.toContain('check_signature');

    fs.writeFileSync(config, 'user edit\n');

    const second = runBootstrap(script, root, {
      FAKE_OPKG_LOG: opkgLog,
      FAKE_FETCH_LOG: fetchedKey,
      MNDW_FETCH: 'fetch-key',
    });

    expect(second.status, String(second.stdout) + '\n' + String(second.stderr)).toBe(0);
    expect(fs.readFileSync(config, 'utf8')).toBe('user edit\n');
    expect(fs.readFileSync(opkgLog, 'utf8')).toBe('update\ninstall mndw\nupdate\ninstall mndw\n');
  });

  it('rejects a device with no exact supported architecture', () => {
    const root = makeFixture();
    const fakeBin = path.join(root, 'bin');

    writeExecutable(path.join(fakeBin, 'opkg'), '#!/bin/sh\necho "arch aarch64-3.10_kn 200"\\n');

    const result = runBootstrap(substituteKeyId(root, 'TESTKEY'), root, {MNDW_FETCH: 'false'});

    expect(result.status).not.toBe(0);
    expect(String(result.stdout) + '\n' + String(result.stderr)).toContain('supported architecture');
    expect(fs.existsSync(path.join(root, 'etc', 'opkg', 'mndw-feed.conf'))).toBe(false);
  });

  it('refuses to run with an unresolved key token', () => {
    const root = makeFixture();
    const result = runBootstrap(addRepoSource, root);

    expect(result.status).not.toBe(0);
    expect(String(result.stdout) + '\n' + String(result.stderr)).toContain('__FEED_KEY_ID__');
  });

  it('publishes a landing page for the hosted per-arch feed', () => {
    const page = fs.readFileSync(path.join(feedRoot, 'index.html'), 'utf8');

    expect(page).toContain('add_repo.sh');
    expect(page).toContain('aarch64-3.10');
    expect(page).toContain('mips-3.4');
    expect(page).toContain('mipsel-3.4');
    expect(page).toContain('check_signature');
    expect(page).toContain('disabled');
  });

  it('labels legacy installer as local-feed-only', () => {
    const source = fs.readFileSync(installSource, 'utf8');

    expect(source).toContain('local feed');
    expect(source).not.toContain('eralde.github.io/mndw-opkg-feed');
  });

  it('signs per-arch indexes and publishes bootstrap assets without hosted install.sh', () => {
    const workflow = fs.readFileSync(publishWorkflow, 'utf8');

    expect(workflow).toContain('OPKG_USIGN_SECRET_KEY_B64');
    expect(workflow).toContain('OPKG_USIGN_PUBLIC_KEY_B64');
    expect(workflow).toContain('MNDW_FEED_KEY_ID');
    expect(workflow).toContain('https://github.com/openwrt/usign.git');
    expect(workflow).toContain('cmake -S');
    expect(workflow).toContain('-DUSE_LIBUBOX=OFF');
    expect(workflow).not.toContain('apt-get install -y usign');
    expect(workflow).toContain('usign -S -m');
    expect(workflow).toContain('usign -V -m');
    expect(workflow).toContain('Packages.sig');
    expect(workflow).toContain('add_repo.sh');
    expect(workflow).toContain('index.html');
    expect(workflow).toContain('out/repo/$MNDW_FEED_KEY_ID.pub');
    expect(workflow).toContain('out/repo/install.sh');
    expect(workflow).toContain('assert');
  });
});
