import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const packagingRoot = path.join(repoRoot, 'build', 'packaging', 'ipk');
const fixtures: string[] = [];

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-lifecycle-test-'));

  fixtures.push(root);
  fs.mkdirSync(path.join(root, 'etc', 'init.d'), {recursive: true});
  fs.mkdirSync(path.join(root, 'share', 'www', 'mndw'), {recursive: true});

  return root;
};

const writeExecutable = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
};

const runScript = (scriptName: string, args: string[], root: string): ReturnType<typeof spawnSync> =>
  (() => {
    const testBin = path.join(root, 'test-bin');
    const chownStub = path.join(testBin, 'chown');
    const chownMarker = path.join(root, 'chown-called');

    fs.mkdirSync(testBin, {recursive: true});
    fs.writeFileSync(chownStub, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$MNDW_CHOWN_MARKER"\n');
    fs.chmodSync(chownStub, 0o755);

    return spawnSync(
      '/bin/sh',
      [path.join(packagingRoot, scriptName), ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${testBin}:${process.env.PATH ?? ''}`,
          MNDW_ROOT: root,
          MNDW_CONFIG_FILE: path.join(root, 'etc', 'mndw.conf'),
          MNDW_USER_PLUGINS_DIR: '',
          MNDW_CHOWN_MARKER: chownMarker,
          MNDW_MNDWD_INIT: path.join(root, 'etc', 'init.d', 'S70mndwd'),
          MNDW_LIGHTTPD_INIT: path.join(root, 'etc', 'init.d', 'S80lighttpd'),
        },
      },
    );
  })();

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

describe('preinst legacy migration', () => {
  it('moves legacy 80-mndw.conf to preserved state before unpack', () => {
    const root = makeRoot();
    const legacy = path.join(root, 'etc', 'lighttpd', 'conf.d', '80-mndw.conf');

    fs.mkdirSync(path.dirname(legacy), {recursive: true});
    fs.writeFileSync(legacy, 'user-edited legacy config\n');

    const result = runScript('preinst', ['upgrade'], root);
    const backup = path.join(root, 'var', 'lib', 'mndw', 'legacy', '80-mndw.conf');

    expect(result.status).toBe(0);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(backup, 'utf8')).toBe('user-edited legacy config\n');
    expect(result.stdout).toContain(backup);
  });

  it('does not overwrite an existing legacy backup', () => {
    const root = makeRoot();
    const legacy = path.join(root, 'etc', 'lighttpd', 'conf.d', '80-mndw.conf');
    const backup = path.join(root, 'var', 'lib', 'mndw', 'legacy', '80-mndw.conf');

    fs.mkdirSync(path.dirname(legacy), {recursive: true});
    fs.mkdirSync(path.dirname(backup), {recursive: true});
    fs.writeFileSync(legacy, 'new legacy\n');
    fs.writeFileSync(backup, 'old backup\n');

    expect(runScript('preinst', ['upgrade'], root).status).toBe(0);
    expect(fs.readFileSync(backup, 'utf8')).toBe('old backup\n');
    expect(fs.readFileSync(`${backup}.1`, 'utf8')).toBe('new legacy\n');
  });

  it('moves legacy user plugins into the durable root before upgrade', () => {
    const root = makeRoot();
    const legacyRoot = path.join(root, 'share', 'www', 'mndw', 'user-plugins');
    const pluginDir = path.join(legacyRoot, 'device-traffic-widget');

    fs.mkdirSync(pluginDir, {recursive: true});
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export const version = 1;');
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), '{}');

    const result = runScript('preinst', ['upgrade'], root);
    const durableRoot = path.join(root, 'var', 'lib', 'mndw', 'user-plugins');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(path.join(durableRoot, 'device-traffic-widget', 'index.js'), 'utf8'))
      .toBe('export const version = 1;');
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(fs.statSync(durableRoot).mode % 0o1000).toBe(0o755);
  });

  it('keeps the legacy root when a stray file prevents best-effort teardown', () => {
    const root = makeRoot();
    const legacyRoot = path.join(root, 'share', 'www', 'mndw', 'user-plugins');
    const pluginDir = path.join(legacyRoot, 'device-traffic-widget');

    fs.mkdirSync(pluginDir, {recursive: true});
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'plugin');
    fs.writeFileSync(path.join(legacyRoot, 'stray-file'), 'keep');

    const result = runScript('preinst', ['upgrade'], root);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(root, 'var', 'lib', 'mndw', 'user-plugins', 'device-traffic-widget'))).toBe(true);
    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(fs.readFileSync(path.join(legacyRoot, 'stray-file'), 'utf8')).toBe('keep');
  });

  it('is idempotent when the legacy root has already been migrated', () => {
    const root = makeRoot();
    const legacyRoot = path.join(root, 'share', 'www', 'mndw', 'user-plugins');
    const pluginDir = path.join(legacyRoot, 'device-traffic-widget');

    fs.mkdirSync(pluginDir, {recursive: true});
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'plugin');

    expect(runScript('preinst', ['upgrade'], root).status).toBe(0);

    const second = runScript('preinst', ['upgrade'], root);

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(
      fs.readFileSync(
        path.join(root, 'var', 'lib', 'mndw', 'user-plugins', 'device-traffic-widget', 'index.js'),
        'utf8',
      ),
    )
      .toBe('plugin');
  });

  it('moves update backup directories without filtering their names', () => {
    const root = makeRoot();
    const legacyBackup = path.join(
      root,
      'share',
      'www',
      'mndw',
      'user-plugins',
      'device-traffic-widget.previous-1.0.0',
      'index.js',
    );

    fs.mkdirSync(path.dirname(legacyBackup), {recursive: true});
    fs.writeFileSync(legacyBackup, 'backup');

    expect(runScript('preinst', ['upgrade'], root).status).toBe(0);
    expect(
      fs.readFileSync(
        path.join(root, 'var', 'lib', 'mndw', 'user-plugins', 'device-traffic-widget.previous-1.0.0', 'index.js'),
        'utf8',
      ),
    )
      .toBe('backup');
  });

  it('aborts without changing either copy on a legacy/durable collision', () => {
    const root = makeRoot();
    const legacyPlugin = path.join(root, 'share', 'www', 'mndw', 'user-plugins', 'device-traffic-widget', 'index.js');
    const durablePlugin = path.join(root, 'var', 'lib', 'mndw', 'user-plugins', 'device-traffic-widget', 'index.js');

    fs.mkdirSync(path.dirname(legacyPlugin), {recursive: true});
    fs.mkdirSync(path.dirname(durablePlugin), {recursive: true});
    fs.writeFileSync(legacyPlugin, 'legacy');
    fs.writeFileSync(durablePlugin, 'durable');

    const result = runScript('preinst', ['upgrade'], root);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(legacyPlugin, 'utf8')).toBe('legacy');
    expect(fs.readFileSync(durablePlugin, 'utf8')).toBe('durable');
  });

  it.each(['preinst', 'postrm'])('does nothing to durable data when %s sees no legacy root', (scriptName) => {
    const root = makeRoot();
    const durableRoot = path.join(root, 'var', 'lib', 'mndw', 'user-plugins');
    const durableFile = path.join(durableRoot, 'existing', 'index.js');
    const stagingFile = path.join(root, 'var', 'lib', 'mndw', 'staging', 'pending.zip');
    const stateFile = path.join(root, 'var', 'lib', 'mndw', 'state.json');
    const policyFile = path.join(root, 'var', 'lib', 'mndw', 'lighttpd-port-policy');

    fs.mkdirSync(path.dirname(durableFile), {recursive: true});
    fs.mkdirSync(path.dirname(stagingFile), {recursive: true});
    fs.writeFileSync(durableFile, 'durable');
    fs.writeFileSync(stagingFile, 'staged');
    fs.writeFileSync(stateFile, '{"state":"keep"}');
    fs.writeFileSync(policyFile, 'mndw\n');
    fs.chmodSync(durableRoot, 0o700);

    const result = runScript(scriptName, [scriptName === 'preinst' ? 'upgrade' : 'remove'], root);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(durableFile, 'utf8')).toBe('durable');
    expect(fs.readFileSync(stagingFile, 'utf8')).toBe('staged');
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('{"state":"keep"}');
    expect(fs.readFileSync(policyFile, 'utf8')).toBe('mndw\n');
    expect(fs.statSync(durableRoot).mode % 0o1000).toBe(0o700);
    expect(fs.existsSync(path.join(root, 'share', 'www', 'mndw', 'user-plugins'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'chown-called'))).toBe(false);
  });
});

describe('upgrade phase guards', () => {
  it('does not stop mndwd during prerm upgrade', () => {
    const root = makeRoot();
    const marker = path.join(root, 'prerm-called');
    const script = fs.readFileSync(path.join(packagingRoot, 'prerm'), 'utf8');

    writeExecutable(path.join(root, 'etc', 'init.d', 'S70mndwd'), `#!/bin/sh\necho called > "${marker}"\n`);

    expect(script).toContain('[ "${1:-}" != "remove" ]');
    expect(runScript('prerm', ['upgrade'], root).status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('does not delete or restart anything during postrm upgrade', () => {
    const root = makeRoot();
    const marker = path.join(root, 'postrm-called');
    const loader = path.join(root, 'etc', 'lighttpd', 'conf.d', '81-mndw.conf');
    const script = fs.readFileSync(path.join(packagingRoot, 'postrm'), 'utf8');

    fs.mkdirSync(path.dirname(loader), {recursive: true});
    fs.writeFileSync(loader, 'keep\n');
    writeExecutable(path.join(root, 'etc', 'init.d', 'S70mndwd'), `#!/bin/sh\necho called > "${marker}"\n`);
    writeExecutable(path.join(root, 'etc', 'init.d', 'S80lighttpd'), `#!/bin/sh\necho called > "${marker}"\n`);

    expect(script).toContain('[ "${1:-}" != "remove" ]');
    expect(runScript('postrm', ['upgrade'], root).status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(loader)).toBe(true);
  });
});

describe('postinst wrapper', () => {
  it('delegates configure to helper through sh', () => {
    const root = makeRoot();
    const marker = path.join(root, 'helper-call');
    const helper = path.join(root, 'helper.sh');

    writeExecutable(helper, `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\n`);

    const result = spawnSync('/bin/sh', [path.join(packagingRoot, 'postinst'), 'configure'], {
      encoding: 'utf8',
      env: {...process.env, MNDW_ROOT: root, MNDW_HELPER: helper},
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('install\n');
  });
});

describe('final removal', () => {
  it('removes package-owned runtime files and restarts remaining lighttpd', () => {
    const root = makeRoot();
    const daemonMarker = path.join(root, 'daemon-marker');
    const lighttpdMarker = path.join(root, 'lighttpd-marker');
    const loader = path.join(root, 'etc', 'lighttpd', 'conf.d', '81-mndw.conf');
    const runtime = path.join(root, 'var', 'lib', 'mndw', 'lighttpd-runtime.conf');

    fs.mkdirSync(path.dirname(loader), {recursive: true});
    fs.mkdirSync(path.dirname(runtime), {recursive: true});
    fs.writeFileSync(loader, 'package-owned loader\n');
    fs.writeFileSync(runtime, 'generated runtime\n');
    fs.writeFileSync(path.join(root, 'share', 'www', 'mndw', 'index.html'), 'host\n');
    fs.mkdirSync(path.join(root, 'var', 'run'), {recursive: true});
    fs.writeFileSync(path.join(root, 'var', 'run', 'mndwd.pid'), '123\n');
    writeExecutable(
      path.join(root, 'etc', 'init.d', 'S70mndwd'),
      '#!/bin/sh\nprintf \'%s\\n\' "$1" > "' + daemonMarker + '"\n',
    );
    writeExecutable(
      path.join(root, 'etc', 'init.d', 'S80lighttpd'),
      '#!/bin/sh\nprintf \'%s\\n\' "$1" > "' + lighttpdMarker + '"\n',
    );

    const result = runScript('postrm', ['remove'], root);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(daemonMarker, 'utf8')).toBe('stop\n');
    expect(fs.readFileSync(lighttpdMarker, 'utf8')).toBe('restart\n');
    expect(fs.existsSync(loader)).toBe(false);
    expect(fs.existsSync(runtime)).toBe(false);
    expect(fs.existsSync(path.join(root, 'var', 'run', 'mndwd.pid'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'share', 'www', 'mndw'))).toBe(false);
  });

  it('migrates legacy user plugins before removing the app root', () => {
    const root = makeRoot();
    const legacyPlugin = path.join(root, 'share', 'www', 'mndw', 'user-plugins', 'device-traffic-widget', 'index.js');
    const daemonMarker = path.join(root, 'daemon-marker');
    const lighttpdMarker = path.join(root, 'lighttpd-marker');

    fs.mkdirSync(path.dirname(legacyPlugin), {recursive: true});
    fs.writeFileSync(legacyPlugin, 'plugin');
    writeExecutable(path.join(root, 'etc', 'init.d', 'S70mndwd'), `#!/bin/sh\necho stop > "${daemonMarker}"\n`);
    writeExecutable(path.join(root, 'etc', 'init.d', 'S80lighttpd'), `#!/bin/sh\necho restart > "${lighttpdMarker}"\n`);

    const result = runScript('postrm', ['remove'], root);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      fs.readFileSync(
        path.join(root, 'var', 'lib', 'mndw', 'user-plugins', 'device-traffic-widget', 'index.js'),
        'utf8',
      ),
    )
      .toBe('plugin');
    expect(fs.existsSync(path.join(root, 'share', 'www', 'mndw'))).toBe(false);
    expect(fs.readFileSync(daemonMarker, 'utf8')).toBe('stop\n');
    expect(fs.readFileSync(lighttpdMarker, 'utf8')).toBe('restart\n');
  });

  it('aborts removal without changing either copy on a legacy/durable collision', () => {
    const root = makeRoot();
    const legacyPlugin = path.join(root, 'share', 'www', 'mndw', 'user-plugins', 'device-traffic-widget', 'index.js');
    const durablePlugin = path.join(root, 'var', 'lib', 'mndw', 'user-plugins', 'device-traffic-widget', 'index.js');

    fs.mkdirSync(path.dirname(legacyPlugin), {recursive: true});
    fs.mkdirSync(path.dirname(durablePlugin), {recursive: true});
    fs.writeFileSync(legacyPlugin, 'legacy');
    fs.writeFileSync(durablePlugin, 'durable');

    const result = runScript('postrm', ['remove'], root);

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, 'share', 'www', 'mndw', 'user-plugins'))).toBe(true);
    expect(fs.readFileSync(legacyPlugin, 'utf8')).toBe('legacy');
    expect(fs.readFileSync(durablePlugin, 'utf8')).toBe('durable');
  });

  it('preserves durable user-plugin and staging data on purge', () => {
    const root = makeRoot();
    const durableFile = path.join(root, 'var', 'lib', 'mndw', 'user-plugins', 'existing', 'index.js');
    const stagingFile = path.join(root, 'var', 'lib', 'mndw', 'staging', 'pending.zip');

    fs.mkdirSync(path.dirname(durableFile), {recursive: true});
    fs.mkdirSync(path.dirname(stagingFile), {recursive: true});
    fs.writeFileSync(durableFile, 'durable');
    fs.writeFileSync(stagingFile, 'staged');

    const result = runScript('postrm', ['purge'], root);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(durableFile, 'utf8')).toBe('durable');
    expect(fs.readFileSync(stagingFile, 'utf8')).toBe('staged');
  });
});

describe('packaging conffiles', () => {
  it('keeps generated lighttpd files out of opkg conffiles', () => {
    const conffiles = fs.readFileSync(path.join(packagingRoot, 'conffiles'), 'utf8');

    expect(conffiles).toContain('/opt/etc/mndw.conf');
    expect(conffiles).not.toContain('80-mndw.conf');
    expect(conffiles).not.toContain('81-mndw.conf');
  });
});
