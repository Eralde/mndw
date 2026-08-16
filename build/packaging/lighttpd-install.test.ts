import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const portHelper = path.join(
  repoRoot,
  'build',
  'packaging',
  'files',
  'opt',
  'share',
  'www',
  'mndw',
  'bin',
  'mndw-lighttpd-port.sh',
);
const renderer = path.join(
  repoRoot,
  'build',
  'packaging',
  'files',
  'opt',
  'share',
  'www',
  'mndw',
  'bin',
  'mndw-render-lighttpd.sh',
);

interface Fixture {
  readonly root: string;
  readonly bin: string;
  readonly proc: string;
}

const fixtures: Fixture[] = [];

const makeFixture = (): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-lighttpd-test-'));
  const fixture: Fixture = {
    root,
    bin: path.join(root, 'bin'),
    proc: path.join(root, 'proc'),
  };

  fs.mkdirSync(fixture.bin, {recursive: true});
  fs.mkdirSync(path.join(fixture.proc, 'net'), {recursive: true});
  fs.writeFileSync(path.join(fixture.proc, 'net', 'tcp'), '  sl  local_address rem_address   st\n');
  fs.writeFileSync(path.join(fixture.proc, 'net', 'tcp6'), '  sl  local_address rem_address   st\n');
  fs.writeFileSync(path.join(fixture.bin, 'netstat'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(path.join(fixture.bin, 'pidof'), '#!/bin/sh\n[ "$FAKE_PROCESS_ACTIVE" = "1" ]\n');
  fs.chmodSync(path.join(fixture.bin, 'netstat'), 0o755);
  fs.chmodSync(path.join(fixture.bin, 'pidof'), 0o755);
  fixtures.push(fixture);

  return fixture;
};

const cleanupFixtures = (): void => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture.root, {recursive: true, force: true});
  }
};

afterEach(cleanupFixtures);

const runScript = (
  script: string,
  args: string[],
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> =>
  spawnSync('/bin/sh', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
      MNDW_ROOT: fixture.root,
      MNDW_PROC_ROOT: fixture.proc,
      ...extraEnv,
    },
  });

const writeProcListeners = (fixture: Fixture, ports: number[], ipv6Ports: number[] = []): void => {
  const rows = ['  sl  local_address rem_address   st'];

  for (const port of ports) {
    const portChunk = port.toString(16)
      .padStart(4, '0')
      .toUpperCase();

    rows.push(`   0: 00000000:${portChunk} 00000000:0000 0A`);
  }

  fs.writeFileSync(path.join(fixture.proc, 'net', 'tcp'), `${rows.join('\n')}\n`);

  const rows6 = ['  sl  local_address rem_address   st'];

  for (const port of ipv6Ports) {
    const portChunk = port.toString(16)
      .padStart(4, '0')
      .toUpperCase();

    rows6.push(
      `   0: 00000000000000000000000000000000:${portChunk} 00000000000000000000000000000000:0000 0A`,
    );
  }

  fs.writeFileSync(path.join(fixture.proc, 'net', 'tcp6'), `${rows6.join('\n')}\n`);
};

const writeExecutable = (file: string, content: string): void => {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
};

interface InstallFixture extends Fixture {
  readonly listeners: string;
  readonly order: string;
  readonly lighttpd: string;
  readonly lighttpdInit: string;
  readonly mndwdInit: string;
  readonly errorLog: string;
  readonly runtime: string;
  readonly proxyTarget: string;
  readonly probeLog: string;
}

const makeInstallFixture = (_probeMode: string): InstallFixture => {
  const base = makeFixture();
  const installFixture: InstallFixture = {
    ...base,
    listeners: path.join(base.root, 'listeners'),
    order: path.join(base.root, 'order'),
    lighttpd: path.join(base.root, 'fake-lighttpd'),
    lighttpdInit: path.join(base.root, 'etc', 'init.d', 'S80lighttpd'),
    mndwdInit: path.join(base.root, 'etc', 'init.d', 'S70mndwd'),
    errorLog: path.join(base.root, 'var', 'log', 'lighttpd', 'error.log'),
    runtime: path.join(base.root, 'var', 'lib', 'mndw', 'lighttpd-runtime.conf'),
    proxyTarget: path.join(base.root, 'var', 'lib', 'mndw', 'proxy-target.conf'),
    probeLog: path.join(base.root, 'tmp', 'mndw', 'lighttpd-probe.log'),
  };

  fs.mkdirSync(path.dirname(installFixture.lighttpdInit), {recursive: true});
  fs.mkdirSync(path.dirname(installFixture.errorLog), {recursive: true});
  fs.mkdirSync(path.dirname(installFixture.runtime), {recursive: true});
  fs.writeFileSync(path.join(base.root, 'etc', 'lighttpd.conf'), 'server.errorlog = "/tmp/error.log"\n');
  fs.writeFileSync(installFixture.order, '');
  fs.writeFileSync(installFixture.listeners, '');
  fs.writeFileSync(installFixture.errorLog, 'old startup line\n');

  writeExecutable(
    path.join(base.bin, 'netstat'),
    `#!/bin/sh
if [ -f "$FAKE_LISTENER_FILE" ]; then
  while IFS= read -r port; do
    [ -n "$port" ] && echo "tcp 0 0 0.0.0.0:$port 0.0.0.0:* LISTEN"
  done < "$FAKE_LISTENER_FILE"
fi
`,
  );

  writeExecutable(
    installFixture.lighttpd,
    `#!/bin/sh
echo "lighttpd:$*" >> "$FAKE_ORDER"
if [ "$1" = "-t" ]; then
  if grep -q '^server.port = ' "$FAKE_RUNTIME_FILE" && grep -q '^server.document-root = ' "$FAKE_RUNTIME_FILE"; then
    echo 'Duplicate config variable in conditional 0 global: server.document-root' >&2
    exit 1
  fi
  exit 0
fi

case "$FAKE_PROBE_MODE" in
  port80)
    echo "bind() 0.0.0.0:80: Address already in use" >&2
    exit 1
    ;;
  port80-ipv6)
    echo "bind() [::]:80: Address already in use" >&2
    exit 1
    ;;
  errorlog)
    echo "bind() 0.0.0.0:80: Address already in use" >> "$MNDW_LIGHTTPD_ERRORLOG"
    exit 1
    ;;
  selected)
    echo "bind() 0.0.0.0:$MNDW_SELECTED_PORT: Address already in use" >&2
    exit 1
    ;;
  selected-then-ready)
    if [ ! -f "$FAKE_ATTEMPT_FILE" ]; then
      : > "$FAKE_ATTEMPT_FILE"
      echo "bind() 0.0.0.0:$MNDW_SELECTED_PORT: Address already in use" >&2
      exit 1
    fi
    printf '%s\\n' "$MNDW_SELECTED_PORT" "$FAKE_BASE_PORT" > "$FAKE_LISTENER_FILE"
    trap 'rm -f "$FAKE_LISTENER_FILE"; exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  ready)
    printf '%s\\n' "$MNDW_SELECTED_PORT" "$FAKE_BASE_PORT" > "$FAKE_LISTENER_FILE"
    trap 'rm -f "$FAKE_LISTENER_FILE"; exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  delayed-ready)
    printf '%s\\n' "$MNDW_SELECTED_PORT" > "$FAKE_LISTENER_FILE"
    (
      sleep 1
      printf '%s\\n' "$MNDW_SELECTED_PORT" "$FAKE_BASE_PORT" > "$FAKE_LISTENER_FILE"
    ) &
    trap 'rm -f "$FAKE_LISTENER_FILE"; exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  stubborn)
    trap '' TERM
    while :; do sleep 1; done
    ;;
esac

exit 1
`,
  );

  writeExecutable(
    installFixture.mndwdInit,
    `#!/bin/sh
echo "mndwd:$1" >> "$FAKE_ORDER"
if [ "$1" = "start" ] || [ "$1" = "restart" ]; then
  proxy_target=\${MNDW_PROXY_TARGET:-\${DATA_DIR:-\$MNDW_ROOT/var/lib/mndw}/proxy-target.conf}
  mkdir -p "$(dirname "$proxy_target")"
  echo 'proxy.server = ( "" => (( "host" => "192.0.2.1", "port" => 80 )) )' > "$proxy_target"
fi
`,
  );

  writeExecutable(
    installFixture.lighttpdInit,
    `#!/bin/sh
echo "lighttpd-init:$1" >> "$FAKE_ORDER"
case "$1" in
  stop)
    if [ "$FAKE_STOP_STATUS" = "dead" ]; then
      echo "Checking lighttpd... dead." >&2
      exit 1
    fi
    exit 0
    ;;
  start|restart)
    if [ "$FAKE_DAEMON_MODE" = "selected" ] || { [ "$FAKE_DAEMON_MODE" = "selected-once" ] && [ ! -f "$FAKE_DAEMON_ATTEMPT" ]; }; then
      : > "$FAKE_DAEMON_ATTEMPT"
      echo "bind() 0.0.0.0:$MNDW_SELECTED_PORT: Address already in use" >&2
      exit 1
    fi
    if [ "$FAKE_DAEMON_MODE" = "delayed" ]; then
      (
        sleep 1
        printf '%s\\n' "$MNDW_SELECTED_PORT" > "$FAKE_LISTENER_FILE"
      ) &
      exit 0
    fi
    if grep -q 'server.port = ' "$FAKE_RUNTIME_FILE"; then
      printf '%s\\n' "$MNDW_SELECTED_PORT" > "$FAKE_LISTENER_FILE"
    else
      printf '%s\\n' "$MNDW_SELECTED_PORT" "$FAKE_BASE_PORT" > "$FAKE_LISTENER_FILE"
    fi
    exit 0
    ;;
esac
exit 2
`,
  );

  return installFixture;
};

const runInstall = (fixture: InstallFixture, extraEnv: Record<string, string> = {}): ReturnType<typeof spawnSync> =>
  runScript(
    portHelper,
    ['install'],
    fixture,
    {
      MNDW_NETSTAT: path.join(fixture.bin, 'netstat'),
      MNDW_LIGHTTPD_BIN: fixture.lighttpd,
      MNDW_LIGHTTPD_INIT: fixture.lighttpdInit,
      MNDW_MNDWD_INIT: fixture.mndwdInit,
      MNDW_LIGHTTPD_CONF: path.join(fixture.root, 'etc', 'lighttpd.conf'),
      MNDW_LIGHTTPD_ERRORLOG: fixture.errorLog,
      MNDW_RENDER_HELPER: renderer,
      MNDW_RUNTIME_CONF: fixture.runtime,
      MNDW_CONFIG_FILE: path.join(fixture.root, 'etc', 'mndw.conf'),
      MNDW_USER_PLUGINS_DIR: '',
      MNDW_PROBE_LOG: fixture.probeLog,
      MNDW_LIGHTTPD_ERRORLOG_LINES: '50',
      MNDW_PROBE_READY_TIMEOUT: '3',
      MNDW_HANDOFF_READY_TIMEOUT: '3',
      MNDW_PROBE_TERM_TIMEOUT: '2',
      MNDW_PROBE_KILL_TIMEOUT: '2',
      MNDW_PROBE_MODE: 'ready',
      FAKE_PROBE_MODE: 'ready',
      FAKE_DAEMON_MODE: 'success',
      FAKE_LISTENER_FILE: fixture.listeners,
      FAKE_ORDER: fixture.order,
      FAKE_ATTEMPT_FILE: path.join(fixture.root, 'attempt'),
      FAKE_DAEMON_ATTEMPT: path.join(fixture.root, 'daemon-attempt'),
      FAKE_RUNTIME_FILE: fixture.runtime,
      FAKE_BASE_PORT: '8080',
      ...extraEnv,
    },
  );

describe('mndw-lighttpd-port.sh', () => {
  it('selects preferred port 99 when no candidate is listening', () => {
    const fixture = makeFixture();
    const result = runScript(portHelper, ['select-port'], fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(String(result.stdout ?? '').trim()).toBe('99');
  });

  it('skips occupied candidates and returns the first free port', () => {
    const fixture = makeFixture();

    writeProcListeners(fixture, [99, 100]);

    const result = runScript(portHelper, ['select-port'], fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(String(result.stdout ?? '').trim()).toBe('101');
  });

  it('reuses a persisted free port', () => {
    const fixture = makeFixture();
    const statePath = path.join(fixture.root, 'var', 'lib', 'mndw', 'lighttpd-port');

    fs.mkdirSync(path.dirname(statePath), {recursive: true});
    fs.writeFileSync(statePath, '123\n');

    const result = runScript(portHelper, ['select-port'], fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(String(result.stdout ?? '').trim()).toBe('123');
  });

  it('reselects when persisted port is occupied', () => {
    const fixture = makeFixture();
    const statePath = path.join(fixture.root, 'var', 'lib', 'mndw', 'lighttpd-port');

    fs.mkdirSync(path.dirname(statePath), {recursive: true});
    fs.writeFileSync(statePath, '123\n');
    writeProcListeners(fixture, [123]);

    const result = runScript(portHelper, ['select-port'], fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(String(result.stdout ?? '').trim()).toBe('99');
  });

  it('falls back to IPv4 and IPv6 proc fixtures when netstat is unavailable', () => {
    const fixture = makeFixture();

    writeProcListeners(fixture, [99], [100]);

    expect(runScript(portHelper, ['is-listening', '99'], fixture).status).toBe(0);
    expect(runScript(portHelper, ['is-listening', '100'], fixture).status).toBe(0);
    expect(runScript(portHelper, ['is-listening', '101'], fixture).status).not.toBe(0);
  });

  it('parses BusyBox netstat output through a PATH shim', () => {
    const fixture = makeFixture();
    const netstat = path.join(fixture.bin, 'netstat');

    fs.writeFileSync(
      netstat,
      '#!/bin/sh\necho "tcp 0 0 0.0.0.0:99 0.0.0.0:* LISTEN"\necho "tcp6 0 0 :::100 :::* LISTEN"\n',
    );
    fs.chmodSync(netstat, 0o755);

    expect(runScript(portHelper, ['is-listening', '99'], fixture).status).toBe(0);
    expect(runScript(portHelper, ['is-listening', '100'], fixture).status).toBe(0);
  });

  it('writes normalized listener snapshots for readiness comparisons', () => {
    const fixture = makeFixture();
    const snapshot = path.join(fixture.root, 'snapshot');

    writeProcListeners(fixture, [99], [100]);

    const result = runScript(portHelper, ['snapshot-listeners', snapshot], fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const lines = fs.readFileSync(snapshot, 'utf8')
      .trim()
      .split('\n');

    expect(lines).toEqual(['tcp4|99', 'tcp6|100']);
  });

  it('rejects invalid persisted ports and invalid writes', () => {
    const fixture = makeFixture();
    const statePath = path.join(fixture.root, 'var', 'lib', 'mndw', 'lighttpd-port');

    fs.mkdirSync(path.dirname(statePath), {recursive: true});
    fs.writeFileSync(statePath, '8080\n');

    expect(runScript(portHelper, ['read-state'], fixture).status).not.toBe(0);
    expect(runScript(portHelper, ['write-state', '8080'], fixture).status).not.toBe(0);
  });
});

describe('mndw-render-lighttpd.sh', () => {
  it('renders socket mode without a global server.port', () => {
    const fixture = makeFixture();
    const output = path.join(fixture.root, 'runtime.conf');
    const result = runScript(renderer, ['--mode', 'socket', '--port', '99', '--output', output], fixture, {
      MNDW_USER_PLUGINS_DIR: '',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const content = fs.readFileSync(output, 'utf8');

    expect(content).toContain('$SERVER["socket"] == ":99"');
    expect(content).not.toContain('server.port =');
    expect(content).toContain('/opt/var/lib/mndw/proxy-target.conf');
    expect(content).toContain('alias.url += ( "/user-plugins/" => "/opt/var/lib/mndw/user-plugins/" )');
  });

  it('renders socket mode with a canonical user-plugin root override', () => {
    const fixture = makeFixture();
    const output = path.join(fixture.root, 'runtime.conf');
    const result = runScript(renderer, ['--mode', 'socket', '--port', '99', '--output', output], fixture, {
      MNDW_USER_PLUGINS_DIR: '/fixture/custom-user-plugins',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const content = fs.readFileSync(output, 'utf8');

    expect(content).toContain('alias.url += ( "/user-plugins/" => "/fixture/custom-user-plugins/" )');
  });

  it('renders override mode with socket-scoped rules and one global server.port', () => {
    const fixture = makeFixture();
    const output = path.join(fixture.root, 'runtime.conf');
    const result = runScript(renderer, ['--mode', 'override', '--port', '101', '--output', output], fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const content = fs.readFileSync(output, 'utf8');

    expect(content.match(/server\.port\s*=\s*101/g)).toHaveLength(1);
    expect(content).toContain('$SERVER["socket"] == ":101"');
    expect(content).toContain('server.document-root');
  });

  it('rejects invalid renderer arguments without replacing an existing file', () => {
    const fixture = makeFixture();
    const output = path.join(fixture.root, 'runtime.conf');

    fs.writeFileSync(output, 'keep');

    const result = runScript(renderer, ['--mode', 'socket', '--port', '80', '--output', output], fixture);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(output, 'utf8')).toBe('keep');
  });
});

describe('mndw-lighttpd-port.sh install', () => {
  it('renders override mode when port-80 bind failure is on probe stderr', () => {
    const fixture = makeInstallFixture('port80');
    const result = runInstall(fixture, {FAKE_PROBE_MODE: 'port80'});
    const diagnostics = fs.existsSync(fixture.probeLog) ? fs.readFileSync(fixture.probeLog, 'utf8') : '';

    expect(result.status, `${result.stdout}\n${result.stderr}\n${diagnostics}`).toBe(0);
    expect(result.stdout).toContain('port 99');
    expect(result.stdout).toContain('bypassed');
    expect(fs.readFileSync(fixture.runtime, 'utf8')).toContain('server.port = 99');
    expect(fs.existsSync(fixture.probeLog)).toBe(false);
    expect(fs.readFileSync(fixture.order, 'utf8')).toMatch(/mndwd:restart[\s\S]*lighttpd:-D/);
  });

  it('continues when lighttpd stop reports an already-dead service', () => {
    const fixture = makeInstallFixture('ready');
    const result = runInstall(fixture, {FAKE_STOP_STATUS: 'dead'});

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('installed');
    expect(result.stderr).not.toContain('lighttpd failed to stop');
  });

  it('fails when lighttpd stop fails and a lighttpd process remains', () => {
    const fixture = makeInstallFixture('ready');
    const result = runInstall(fixture, {FAKE_STOP_STATUS: 'dead', FAKE_PROCESS_ACTIVE: '1'});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lighttpd failed to stop');
  });

  it('renders override mode when IPv6 port-80 bind failure is on probe stderr', () => {
    const fixture = makeInstallFixture('port80-ipv6');
    const result = runInstall(fixture, {FAKE_PROBE_MODE: 'port80-ipv6'});

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('bypassed');
    expect(fs.readFileSync(fixture.runtime, 'utf8')).toContain('server.port = 99');
  });

  it('renders override mode when port-80 bind failure is only in the errorlog delta', () => {
    const fixture = makeInstallFixture('errorlog');
    const result = runInstall(fixture, {FAKE_PROBE_MODE: 'errorlog'});
    const diagnostics = fs.existsSync(fixture.probeLog) ? fs.readFileSync(fixture.probeLog, 'utf8') : '';

    expect(result.status, `${result.stdout}\n${result.stderr}\n${diagnostics}`).toBe(0);
    expect(result.stdout).toContain('bypassed');
    expect(fs.readFileSync(fixture.runtime, 'utf8')).toContain('server.port = 99');
  });

  it('keeps socket mode when selected and base listeners become ready', () => {
    const fixture = makeInstallFixture('ready');
    const result = runInstall(fixture);
    const diagnostics = fs.existsSync(fixture.probeLog) ? fs.readFileSync(fixture.probeLog, 'utf8') : '';
    const runtime = fs.readFileSync(fixture.runtime, 'utf8');

    expect(result.status, `${result.stdout}\n${result.stderr}\n${diagnostics}`).toBe(0);
    expect(runtime).toContain('$SERVER["socket"] == ":99"');
    expect(runtime).not.toContain('server.port =');
    expect(fs.readFileSync(path.join(fixture.root, 'var', 'lib', 'mndw', 'lighttpd-port'), 'utf8').trim()).toBe('99');
    expect(fs.readFileSync(fixture.listeners, 'utf8').split('\n')).toContain('8080');
  });

  it('uses the configured canonical user-plugin root when rendering during install', () => {
    const fixture = makeInstallFixture('ready');
    const configuredRoot = path.join(fixture.root, 'custom-user-plugins');

    fs.mkdirSync(path.dirname(path.join(fixture.root, 'etc', 'mndw.conf')), {recursive: true});
    fs.writeFileSync(path.join(fixture.root, 'etc', 'mndw.conf'), `MNDW_USER_PLUGINS_DIR="${configuredRoot}"\n`);

    const result = runInstall(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(fixture.runtime, 'utf8')).toContain(
      `alias.url += ( "/user-plugins/" => "${configuredRoot}/" )`,
    );
  });

  it('derives install helper plugin and proxy paths from custom DATA_DIR', () => {
    const fixture = makeInstallFixture('ready');
    const dataDir = path.join(fixture.root, 'custom-data');

    fs.mkdirSync(path.dirname(path.join(fixture.root, 'etc', 'mndw.conf')), {recursive: true});
    fs.writeFileSync(path.join(fixture.root, 'etc', 'mndw.conf'), `DATA_DIR="${dataDir}"\n`);

    const result = runInstall(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'proxy-target.conf'))).toBe(true);
    expect(fs.readFileSync(fixture.runtime, 'utf8')).toContain(
      `alias.url += ( "/user-plugins/" => "${dataDir}/user-plugins/" )`,
    );
    expect(fs.readFileSync(fixture.runtime, 'utf8')).toContain(path.join(dataDir, 'proxy-target.conf'));
    expect(fs.readFileSync(path.join(fixture.root, 'var', 'lib', 'mndw', 'lighttpd-port'), 'utf8').trim()).toBe('99');
  });

  it('accepts a base listener that appears before the readiness deadline', () => {
    const fixture = makeInstallFixture('delayed-ready');
    const result = runInstall(fixture, {FAKE_PROBE_MODE: 'delayed-ready'});

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('port 99');
  }, 15000);

  it('advances to next candidate only after selected-port probe failure', () => {
    const fixture = makeInstallFixture('selected-then-ready');
    const result = runInstall(fixture, {FAKE_PROBE_MODE: 'selected-then-ready'});
    const diagnostics = fs.existsSync(fixture.probeLog) ? fs.readFileSync(fixture.probeLog, 'utf8') : '';

    expect(result.status, `${result.stdout}\n${result.stderr}\n${diagnostics}`).toBe(0);
    expect(result.stdout).toContain('port 100');
    expect(fs.readFileSync(fixture.runtime, 'utf8')).toContain(':100');
    expect(fs.readFileSync(path.join(fixture.root, 'var', 'lib', 'mndw', 'lighttpd-port'), 'utf8').trim()).toBe('100');
  }, 15000);

  it('advances after a real daemon selected-port failure without truncating the run log', () => {
    const fixture = makeInstallFixture('ready');
    const result = runInstall(fixture, {FAKE_DAEMON_MODE: 'selected-once'});

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('port 100');
    expect(fs.existsSync(fixture.probeLog)).toBe(false);
  }, 15000);

  it('waits for the selected listener after daemon handoff', () => {
    const fixture = makeInstallFixture('ready');
    const result = runInstall(fixture, {FAKE_DAEMON_MODE: 'delayed'});

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('installed');
  }, 10000);

  it('reports candidate exhaustion without a success message', () => {
    const fixture = makeInstallFixture('selected');

    writeProcListeners(fixture, Array.from({length: 101}, (_unused, index) => 99 + index));

    const result = runInstall(fixture, {
      FAKE_PROBE_MODE: 'ready',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exhausted mndw port range 99..199');
    expect(result.stdout).not.toContain('installed');
    expect(fs.existsSync(fixture.probeLog)).toBe(true);
  }, 30000);

  it('bounds cleanup when a probe ignores SIGTERM', () => {
    const fixture = makeInstallFixture('stubborn');
    const result = runInstall(fixture, {
      FAKE_PROBE_MODE: 'stubborn',
      MNDW_PROBE_READY_TIMEOUT: '0',
      MNDW_PROBE_TERM_TIMEOUT: '1',
      MNDW_PROBE_KILL_TIMEOUT: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lighttpd probe failed');
    expect(fs.existsSync(fixture.probeLog)).toBe(true);
  }, 10000);
});
