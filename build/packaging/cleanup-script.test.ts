import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

interface CleanupFixture {
  readonly root: string;
  readonly tempDir: string;
  readonly scriptPath: string;
  readonly opkgLog: string;
  readonly env: NodeJS.ProcessEnv;
  dispose(): void;
}

interface FixtureOptions {
  readonly resolvedKey?: boolean;
  readonly artifacts?: boolean;
  readonly packages?: string;
}

const sourceScript = path.join(import.meta.dirname, 'files', 'opt', 'bin', 'mndw-cleanup');

const createFixture = (options: FixtureOptions = {}): CleanupFixture => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-cleanup-test-'));
  const root = path.join(tempDir, 'root');
  const binDir = path.join(tempDir, 'bin');
  const scriptPath = path.join(tempDir, 'deployed', 'mndw-cleanup');
  const opkgLog = path.join(tempDir, 'opkg.log');
  const initLog = path.join(tempDir, 'init.log');
  const daemonPath = path.join(root, 'sbin', 'mndwd');
  const opkgPath = path.join(binDir, 'opkg');
  const daemon = [
    '#!/bin/sh',
    'case " $* " in',
    '  *" --print-plugin-packages "*)',
    '    if [ -n "${PLUGIN_PACKAGES:-}" ]; then printf "%s\\n" "$PLUGIN_PACKAGES"; fi',
    '    exit "${MNDWD_STATUS:-0}"',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  const opkg = [
    '#!/bin/sh',
    'case "${1:-}" in',
    '  status)',
    '    printf "Package: mndw\\nDepends: base-dep, shared-pkg\\n"',
    '    ;;',
    '  list-installed)',
    '    printf "base-dep - 1.0\\nshared-pkg - 1.0\\nplugin-a - 1.0\\nplugin-b - 1.0\\n"',
    '    ;;',
    '  remove)',
    '    printf "%s %s\\n" "$1" "$2" >> "$OPKG_LOG"',
    '    [ "${FAIL_PACKAGE:-}" != "$2" ]',
    '    ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(daemonPath), {recursive: true});
  fs.mkdirSync(binDir, {recursive: true});
  fs.mkdirSync(path.dirname(scriptPath), {recursive: true});
  fs.writeFileSync(daemonPath, daemon);
  fs.writeFileSync(opkgPath, opkg);
  fs.chmodSync(daemonPath, 0o755);
  fs.chmodSync(opkgPath, 0o755);

  const initPath = path.join(root, 'etc', 'init.d', 'S70mndwd');

  fs.mkdirSync(path.dirname(initPath), {recursive: true});
  fs.writeFileSync(initPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INIT_LOG"\n');
  fs.chmodSync(initPath, 0o755);

  let cleanupScript = fs.readFileSync(sourceScript, 'utf8');

  if (options.resolvedKey !== false) {
    cleanupScript = cleanupScript.replace(
      'FEED_KEY_ID=__FEED_KEY_ID__',
      'FEED_KEY_ID=mndw-test-key',
    );
  }

  fs.writeFileSync(scriptPath, cleanupScript);
  fs.chmodSync(scriptPath, 0o755);

  if (options.artifacts !== false) {
    const paths = [
      'var/lib/mndw/user-plugins/example/manifest.json',
      'var/lib/mndw-secrets/rci-session.key',
      'var/mndw/opkg-cache/index',
      'tmp/mndw/plugin-runtime/state',
      'var/log/mndwd.crash.log',
      'var/log/mndwd.crash.log.1',
      'var/run/mndwd.pid',
      'etc/opkg/mndw-feed.conf',
      'var/opkg-lists/mndw',
      'var/opkg-lists/mndw.sig',
      'etc/opkg/keys/mndw-test-key.pub',
      'etc/opkg/keys/other-key.pub',
      'etc/mndw.conf',
      'share/www/mndw/index.html',
      'etc/ndm/wan.d/10-mndw',
      'bin/mndw-cleanup',
    ];

    for (const relativePath of paths) {
      const fullPath = path.join(root, relativePath);

      fs.mkdirSync(path.dirname(fullPath), {recursive: true});
      fs.writeFileSync(fullPath, relativePath === 'etc/mndw.conf' ? '' : `fixture: ${relativePath}\n`);
    }
  } else {
    fs.rmSync(daemonPath, {force: true});
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MNDW_ROOT: root,
    MNDW_MNDWD_INIT: initPath,
    MNDWD_BIN: daemonPath,
    OPKG: opkgPath,
    OPKG_LOG: opkgLog,
    INIT_LOG: initLog,
    PLUGIN_PACKAGES: options.packages
      ?? 'base-dep core-plugin\nnot-installed missing-plugin\nplugin-a alpha\nplugin-b beta\nshared-pkg utility-plugin',
    FAIL_PACKAGE: 'plugin-b',
  };

  return {
    root,
    tempDir,
    scriptPath,
    opkgLog,
    env,
    dispose: () => fs.rmSync(tempDir, {recursive: true, force: true}),
  };
};

const runCleanup = (
  fixture: CleanupFixture,
  args: string[] = ['--yes'],
): ReturnType<typeof spawnSync> => {
  return spawnSync('/bin/sh', [fixture.scriptPath, ...args], {env: fixture.env, encoding: 'utf8'});
};

const shellQuote = (value: string): string => {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`;
};

const runInteractive = (fixture: CleanupFixture, input: string): ReturnType<typeof spawnSync> => {
  const command = ['/bin/sh', fixture.scriptPath].map(shellQuote).join(' ');

  if (process.platform === 'darwin') {
    const expectPath = path.join(fixture.tempDir, 'interactive.exp');
    const escapedScriptPath = fixture.scriptPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const escapedInput = input.replaceAll('\\', '\\\\');
    const escapedAnswer = escapedInput.replaceAll('"', '\\"');
    const answer = escapedAnswer.replaceAll('\n', '\\r');

    fs.writeFileSync(
      expectPath,
      `set timeout 5\nspawn -noecho /bin/sh "${escapedScriptPath}"\nsend -- "${answer}"\nexpect eof\nset result [wait]\nexit [lindex $result 3]\n`,
    );

    return spawnSync('expect', [expectPath], {env: fixture.env, encoding: 'utf8'});
  }

  const args = ['-q', '-e', '-c', command, '/dev/null'];

  return spawnSync('script', args, {env: fixture.env, input, encoding: 'utf8'});
};

const expectDefaultDataRemoved = (fixture: CleanupFixture): void => {
  expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw-secrets'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'var', 'mndw'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'tmp', 'mndw'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'var', 'log', 'mndwd.crash.log'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'var', 'log', 'mndwd.crash.log.1'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'var', 'run', 'mndwd.pid'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'etc', 'opkg', 'mndw-feed.conf'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'var', 'opkg-lists', 'mndw'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'var', 'opkg-lists', 'mndw.sig'))).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, 'etc', 'mndw.conf'))).toBe(false);
};

describe('mndw-cleanup script', () => {
  it('--yes removes mndw data, preserves package-owned files and other feed keys, and filters opkg removals', () => {
    const fixture = createFixture();

    try {
      const result = runCleanup(fixture);

      expect(result.status).toBe(0);
      expectDefaultDataRemoved(fixture);
      expect(fs.existsSync(path.join(fixture.root, 'etc', 'opkg', 'keys', 'mndw-test-key.pub'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, 'etc', 'opkg', 'keys', 'other-key.pub'))).toBe(true);

      expect(result.stdout).toContain(
        'After that you will be asked whether to remove these packages installed for user plugins:\n  plugin-a (alpha)\n  plugin-b (beta)',
      );

      for (
        const relativePath of [
          'sbin/mndwd',
          'share/www/mndw/index.html',
          'etc/init.d/S70mndwd',
          'etc/ndm/wan.d/10-mndw',
          'bin/mndw-cleanup',
        ]
      ) {
        expect(fs.existsSync(path.join(fixture.root, relativePath))).toBe(true);
      }

      expect(fs.readFileSync(fixture.opkgLog, 'utf8')).toBe('remove plugin-a\nremove plugin-b\n');
      expect(result.stderr).toContain('plugin-b');
      expect(result.stdout).toContain('Users & Access');
      expect(result.stdout).toContain('opkg remove --autoremove mndw');
    } finally {
      fixture.dispose();
    }
  });

  it('keeps feed keys untouched when the build token is unresolved', () => {
    const fixture = createFixture({resolvedKey: false});

    try {
      const result = runCleanup(fixture);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(fixture.root, 'etc', 'opkg', 'keys', 'mndw-test-key.pub'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, 'etc', 'opkg', 'keys', 'other-key.pub'))).toBe(true);
      expect(result.stdout).toContain(path.join(fixture.root, 'etc', 'opkg', 'keys'));
      expect(result.stdout).toMatch(/remove.*key.*by hand/i);
      expect(result.stdout.indexOf('feed key id is unresolved')).toBeGreaterThan(
        result.stdout.indexOf('  plugin-b (beta)'),
      );
      expect(result.stdout.indexOf('feed key id is unresolved')).toBeGreaterThan(
        result.stdout.indexOf(`  ${path.join(fixture.root, 'var', 'lib', 'mndw')}`),
      );
    } finally {
      fixture.dispose();
    }
  });

  it('honours data and external user-plugin directories from mndw.conf', () => {
    const fixture = createFixture();
    const customDataDir = path.join(fixture.root, 'custom', 'data');
    const customPluginsDir = path.join(fixture.root, 'external', 'plugins');
    const configPath = path.join(fixture.root, 'etc', 'mndw.conf');

    try {
      fs.mkdirSync(path.join(customDataDir, 'state'), {recursive: true});
      fs.mkdirSync(path.join(customPluginsDir, 'plugin-a'), {recursive: true});
      fs.writeFileSync(path.join(customDataDir, 'state', 'state.json'), '{}');
      fs.writeFileSync(path.join(customPluginsDir, 'plugin-a', 'manifest.json'), '{}');
      fs.writeFileSync(
        configPath,
        'DATA_DIR=$MNDW_ROOT/custom/data\nMNDW_USER_PLUGINS_DIR=$MNDW_ROOT/external/plugins\n',
      );

      const result = runCleanup(fixture);

      expect(result.status).toBe(0);
      expect(fs.existsSync(customDataDir)).toBe(false);
      expect(fs.existsSync(customPluginsDir)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('declining the file prompt leaves files and plugin packages untouched', () => {
    const fixture = createFixture();

    try {
      const result = runInteractive(fixture, 'n\n');

      expect(result.status).toBe(1);
      expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, 'etc', 'mndw.conf'))).toBe(true);
      expect(fs.existsSync(fixture.opkgLog)).toBe(false);

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(output.indexOf('mndw cleanup will remove these existing files and directories:')).toBeLessThan(
        output.indexOf('After that you will be asked whether to remove these packages installed for user plugins:'),
      );
      expect(output).toContain('  plugin-a (alpha)');
      expect(output).toContain('  plugin-b (beta)');
      expect(output.indexOf('  plugin-b (beta)')).toBeLessThan(
        output.indexOf('Remove all mndw data and settings? [y/N]'),
      );
      expect(output).not.toContain('Remove these packages too? [y/N]');
    } finally {
      fixture.dispose();
    }
  });

  it('shows all plugins that share a package in the plan and removes the package once', () => {
    const fixture = createFixture({packages: 'plugin-a alpha,beta'});

    try {
      const result = runCleanup(fixture);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('  plugin-a (alpha, beta)');
      expect(fs.readFileSync(fixture.opkgLog, 'utf8')).toBe('remove plugin-a\n');
    } finally {
      fixture.dispose();
    }
  });

  it('declining only the package prompt removes files but keeps packages installed', () => {
    const fixture = createFixture();

    try {
      const result = runInteractive(fixture, 'y\nn\n');

      expect(result.status).toBe(0);
      expectDefaultDataRemoved(fixture);
      expect(fs.existsSync(fixture.opkgLog)).toBe(false);

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(output).toContain('The following installed packages were declared by approved user plugins:');
      expect(output).toContain('  plugin-a (alpha)');
      expect(output).toContain('  plugin-b (beta)');
      expect(output).toContain('Other programs may still use these packages.');
      expect(output).toContain('Remove these packages too? [y/N]');
    } finally {
      fixture.dispose();
    }
  });

  it('refuses non-interactive use without --yes', () => {
    const fixture = createFixture();

    try {
      const result = runCleanup(fixture, []);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/stdin.*terminal|terminal.*--yes/i);
      expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('returns success when there are no files or plugin packages to remove', () => {
    const fixture = createFixture({artifacts: false, packages: ''});

    try {
      const result = runCleanup(fixture);

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/nothing to remove/i);
      expect(result.stdout).not.toContain('After that you will be asked');
      expect(fs.existsSync(fixture.opkgLog)).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('asks about packages when no files remain to remove', () => {
    const fixture = createFixture();

    try {
      for (const relativePath of ['var', 'tmp/mndw', 'etc/opkg', 'etc/mndw.conf']) {
        fs.rmSync(path.join(fixture.root, relativePath), {recursive: true, force: true});
      }

      const result = runInteractive(fixture, 'n\n');
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status).toBe(0);
      expect(output).toMatch(/nothing to remove/i);
      expect(output).not.toContain('Remove all mndw data and settings? [y/N]');
      expect(output).toContain('Remove these packages too? [y/N]');
      expect(fs.existsSync(fixture.opkgLog)).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('warns when mndwd is missing and still removes files', () => {
    const fixture = createFixture({artifacts: false, packages: ''});

    try {
      for (
        const relativePath of [
          'var/lib/mndw/marker',
          'etc/mndw.conf',
        ]
      ) {
        const fullPath = path.join(fixture.root, relativePath);

        fs.mkdirSync(path.dirname(fullPath), {recursive: true});
        fs.writeFileSync(fullPath, 'data');
      }

      const result = runCleanup(fixture);

      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/mndwd.*(missing|unavailable)|plugin package/i);
      expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw'))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('returns status 2 when a requested data path overlaps a package-owned file', () => {
    const fixture = createFixture({packages: ''});

    try {
      const configPath = path.join(fixture.root, 'etc', 'mndw.conf');

      fs.mkdirSync(path.dirname(configPath), {recursive: true});
      fs.writeFileSync(configPath, 'DATA_DIR=$MNDW_ROOT/sbin/mndwd\n');

      const result = runCleanup(fixture);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/refusing cleanup path.*package files/i);
      expect(fs.existsSync(path.join(fixture.root, 'sbin', 'mndwd'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('refuses DATA_DIR at a shared var directory and removes other safe targets', () => {
    const fixture = createFixture({packages: ''});
    const configPath = path.join(fixture.root, 'etc', 'mndw.conf');
    const varDir = path.join(fixture.root, 'var');
    const unrelatedPath = path.join(varDir, 'unrelated-state');

    try {
      fs.writeFileSync(configPath, 'DATA_DIR=$MNDW_ROOT/var/\n');
      fs.writeFileSync(unrelatedPath, 'keep\n');

      const result = runCleanup(fixture);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/refusing cleanup path.*shared/i);
      expect(result.stdout).not.toContain(`  ${varDir}\n`);
      expect(fs.existsSync(varDir)).toBe(true);
      expect(fs.existsSync(unrelatedPath)).toBe(true);
      expect(fs.existsSync(path.join(varDir, 'lib', 'mndw'))).toBe(true);
      expect(fs.existsSync(path.join(varDir, 'lib', 'mndw-secrets'))).toBe(false);
      expect(fs.existsSync(path.join(varDir, 'mndw'))).toBe(false);
      expect(fs.existsSync(path.join(varDir, 'log', 'mndwd.crash.log'))).toBe(false);
      expect(fs.existsSync(path.join(varDir, 'run', 'mndwd.pid'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, 'etc', 'opkg', 'mndw-feed.conf'))).toBe(false);
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('refuses MNDW_USER_PLUGINS_DIR at MNDW_ROOT and removes other safe targets', () => {
    const fixture = createFixture({packages: ''});
    const configPath = path.join(fixture.root, 'etc', 'mndw.conf');
    const unrelatedPath = path.join(fixture.root, 'unrelated-state');

    try {
      fs.writeFileSync(configPath, 'MNDW_USER_PLUGINS_DIR=$MNDW_ROOT\n');
      fs.writeFileSync(unrelatedPath, 'keep\n');

      const result = runCleanup(fixture);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/refusing cleanup path.*shared/i);
      expect(result.stdout).not.toContain(`  ${fixture.root}\n`);
      expect(fs.existsSync(fixture.root)).toBe(true);
      expect(fs.existsSync(unrelatedPath)).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw-secrets'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, 'var', 'mndw'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, 'etc', 'opkg', 'mndw-feed.conf'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, 'sbin', 'mndwd'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, 'etc', 'mndw.conf'))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });
});
