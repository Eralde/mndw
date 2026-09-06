import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(repoRoot, 'build', 'packaging', 'hooks', 'ndm', 'wan.d', '10-mndw');
const fixtures: string[] = [];

const runHook = (root: string, bin: string, args: string[], values: Record<string, string>): string => {
  const result = spawnSync('sh', [script, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...values,
      MNDW_ROOT: root,
      MNDW_PORT_FILE: path.join(root, 'var', 'lib', 'mndw', 'frontend-port'),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
  });

  expect(result.status, result.stderr).toBe(0);

  return fs.readFileSync(path.join(root, 'curl-body'), 'utf8');
};

describe('NDMS hook scripts', () => {
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fs.rmSync(fixture, {recursive: true, force: true});
    }
  });

  it('preserves the last WAN interface when NDMS omits it on stop', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-hook-'));

    fixtures.push(root);

    const bin = path.join(root, 'bin');

    fs.mkdirSync(path.join(root, 'var', 'lib', 'mndw'), {recursive: true});
    fs.mkdirSync(bin, {recursive: true});
    fs.writeFileSync(path.join(root, 'var', 'lib', 'mndw', 'frontend-port'), '99\n');
    fs.writeFileSync(
      path.join(bin, 'curl'),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = -d ]; then printf "%s" "$2" > "$MNDW_ROOT/curl-body"; fi\n  shift\ndone\n',
    );
    fs.chmodSync(path.join(bin, 'curl'), 0o755);

    const startBody = runHook(root, bin, ['start'], {
      interface: 'ppp0',
      address: '192.0.2.10',
      mask: '255.255.255.0',
      gateway: '192.0.2.1',
    });

    expect(JSON.parse(startBody)).toMatchObject({hook: 'wan.d', action: 'start'});

    const stopBody = runHook(root, bin, ['stop'], {});

    expect(JSON.parse(stopBody)).toEqual({
      hook: 'wan.d',
      action: 'stop',
      payload: {interface: 'ppp0'},
    });
  });
});
