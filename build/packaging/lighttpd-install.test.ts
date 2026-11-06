import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const initScript = path.join(repoRoot, 'build', 'packaging', 'init', 'S70mndwd');
const devicePortHelper = path.join(
  repoRoot,
  'build',
  'packaging',
  'files',
  'opt',
  'share',
  'www',
  'mndw',
  'bin',
  'mndw-device-port.sh',
);
const fixtures: string[] = [];

const writeExecutable = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
};

interface InitFixture {
  readonly root: string;
  readonly mode: 'success' | 'failure';
  readonly args: string;
  readonly deviceHelper: string;
  readonly daemon: string;
  readonly daemonPid: string;
  readonly portFile: string;
}

const makeInitFixture = (mode: InitFixture['mode']): InitFixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-front-door-test-'));

  fixtures.push(root);

  const deviceHelper = path.join(root, 'share', 'www', 'mndw', 'bin', 'mndw-device-port.sh');
  const daemon = path.join(root, 'sbin', 'mndwd');
  const args = path.join(root, 'daemon-args');
  const daemonPid = path.join(root, 'var', 'run', 'mndwd.pid');
  const portFile = path.join(root, 'var', 'lib', 'mndw', 'frontend-port');

  writeExecutable(deviceHelper, '#!/bin/sh\nprintf \'%s\\n\' 8081\n');
  writeExecutable(
    daemon,
    `#!/bin/sh
printf '%s\n' "$*" > "$FAKE_DAEMON_ARGS"
if [ "$FAKE_DAEMON_MODE" = failure ]; then
  exit 0
fi
mkdir -p "$(dirname "$FAKE_PORT_FILE")"
temporary="$FAKE_PORT_FILE.$$"
printf '%s\n' 99 > "$temporary"
mv "$temporary" "$FAKE_PORT_FILE"
exec sleep 30
`,
  );
  writeExecutable(path.join(root, 'bin', 'ip'), '#!/bin/sh\nprintf \'%s\\n\' \'inet 192.0.2.1/24 br0\'\n');
  fs.mkdirSync(path.dirname(daemonPid), {recursive: true});
  fs.mkdirSync(path.dirname(portFile), {recursive: true});

  return {root, mode, args, deviceHelper, daemon, daemonPid, portFile};
};

const runInit = (
  fixture: InitFixture,
  command: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> =>
  spawnSync('/bin/sh', [initScript, command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(fixture.root, 'bin')}:${process.env.PATH ?? ''}`,
      MNDW_ROOT: fixture.root,
      MNDW_PROC_ROOT: path.join(fixture.root, 'proc'),
      MNDW_DEVICE_PORT_HELPER: fixture.deviceHelper,
      MNDW_DAEMON: fixture.daemon,
      FAKE_DAEMON_ARGS: fixture.args,
      FAKE_DAEMON_MODE: fixture.mode,
      FAKE_PORT_FILE: fixture.portFile,
      ...extraEnv,
    },
  });

const writeProcCmdline = (fixture: InitFixture, pid: number): void => {
  const directory = path.join(fixture.root, 'proc', `${pid}`);

  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'cmdline'), `${fixture.daemon}\0`);
};

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    try {
      const pid = Number(fs.readFileSync(path.join(root, 'var', 'run', 'mndwd.pid'), 'utf8').trim());

      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The daemon may already have exited.
        }
      }
    } catch {
      // The daemon may not have written a PID file.
    }

    fs.rmSync(root, {recursive: true, force: true});
  }
});

describe('S70mndwd front door', () => {
  it('passes front-door flags, reports selected URL, and writes no proxy target', () => {
    const fixture = makeInitFixture('success');
    const result = runInit(fixture, 'start');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('mndw dashboard: http://192.0.2.1:99/');

    const args = fs.readFileSync(fixture.args, 'utf8');

    expect(args).toContain(`--frontend-dir ${fixture.root}/share/www/mndw`);
    expect(args).toContain(`--user-plugins-dir ${fixture.root}/var/lib/mndw/user-plugins`);
    expect(args).toContain('--device-url http://192.0.2.1:8081');
    expect(args).not.toContain('--listen');
    expect(fs.existsSync(path.join(fixture.root, 'var', 'lib', 'mndw', 'proxy-target.conf'))).toBe(false);

    const daemonPid = Number(fs.readFileSync(fixture.daemonPid, 'utf8').trim());

    writeProcCmdline(fixture, daemonPid);

    const stop = runInit(fixture, 'stop');

    expect(stop.status, `${stop.stdout}\n${stop.stderr}`).toBe(0);
    expect(() => process.kill(daemonPid, 0)).toThrow();
    expect(fs.existsSync(fixture.daemonPid)).toBe(false);
  }, 10000);

  it('fails and removes the PID file when daemon does not report a port', () => {
    const fixture = makeInitFixture('failure');
    const result = runInit(fixture, 'start');

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(fixture.daemonPid)).toBe(false);
  });

  it('does not read the legacy router helper override', () => {
    const fixture = makeInitFixture('success');
    const result = runInit(fixture, 'start', {
      MNDW_DEVICE_PORT_HELPER: '',
      MNDW_ROUTER_PORT_HELPER: path.join(fixture.root, 'missing-router-port-helper'),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const daemonPid = Number(fs.readFileSync(fixture.daemonPid, 'utf8').trim());

    writeProcCmdline(fixture, daemonPid);

    const stop = runInit(fixture, 'stop');

    expect(stop.status, `${stop.stdout}\n${stop.stderr}`).toBe(0);
    expect(() => process.kill(daemonPid, 0)).toThrow();
    expect(fs.existsSync(fixture.daemonPid)).toBe(false);
  }, 10000);
});

describe('mndw-device-port.sh device-port discovery', () => {
  it('excludes both live and legacy dashboard port files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-device-port-test-'));

    fixtures.push(root);

    const bin = path.join(root, 'bin');
    const dataDir = path.join(root, 'var', 'lib', 'mndw');
    const netstat = path.join(bin, 'netstat');
    const curl = path.join(bin, 'curl');

    fs.mkdirSync(bin, {recursive: true});
    fs.mkdirSync(dataDir, {recursive: true});
    fs.writeFileSync(path.join(dataDir, 'frontend-port'), '99\n');
    fs.writeFileSync(path.join(dataDir, 'lighttpd-port'), '100\n');
    writeExecutable(
      netstat,
      `#!/bin/sh
cat <<'EOF'
tcp 0 0 0.0.0.0:99 0.0.0.0:* LISTEN
tcp 0 0 0.0.0.0:100 0.0.0.0:* LISTEN
tcp 0 0 192.0.2.1:8081 0.0.0.0:* LISTEN
EOF
`,
    );
    writeExecutable(
      curl,
      `#!/bin/sh
case "$*" in
  *:100/auth*|*:8081/auth*) printf '%s\\n' 'WWW-Authenticate: x-ndw4-interactive' ;;
esac
`,
    );

    const result = spawnSync('/bin/sh', [devicePortHelper, 'detect', '192.0.2.1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        MNDW_ROOT: root,
        MNDW_NETSTAT: netstat,
        MNDW_CURL: curl,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe('8081');
  });

  it('accepts canonical device port override without probing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-device-port-test-'));

    fixtures.push(root);

    const result = spawnSync('/bin/sh', [devicePortHelper, 'detect', '192.0.2.1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MNDW_ROOT: root,
        MNDW_DEVICE_PORT: '8081',
        MNDW_NETSTAT: '/missing/netstat',
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe('8081');
  });

  it('does not accept the legacy router port override', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-device-port-test-'));

    fixtures.push(root);

    const result = spawnSync('/bin/sh', [devicePortHelper, 'detect', '192.0.2.1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MNDW_ROOT: root,
        MNDW_ROUTER_PORT: '8081',
        MNDW_NETSTAT: '/missing/netstat',
      },
    });

    expect(result.status).not.toBe(0);
  });
});
