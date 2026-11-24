import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

interface HookCase {
  readonly name: string;
  readonly hook: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly files?: Record<string, string>;
  readonly expectedFiles?: Record<string, string | null>;
  readonly body: unknown;
  readonly event: {readonly topic: string; readonly payload: unknown};
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const goldenDirectory = path.join(repoRoot, 'contracts', 'hooks');
const cases: HookCase[] = fs.readdirSync(goldenDirectory)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => {
    return JSON.parse(fs.readFileSync(path.join(goldenDirectory, file), 'utf8')) as HookCase;
  });
const fixtures: string[] = [];

const hookCase = (name: string): HookCase => {
  const testCase = cases.find((item) => item.name === name);

  if (!testCase) {
    throw new Error(`Missing hook contract: ${name}`);
  }

  return testCase;
};

const createHookRoot = (): {root: string; bin: string} => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-hook-'));
  const bin = path.join(root, 'bin');

  fixtures.push(root);
  fs.mkdirSync(path.join(root, 'var', 'lib', 'mndw'), {recursive: true});
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(path.join(root, 'var', 'lib', 'mndw', 'frontend-port'), '99\n');
  fs.writeFileSync(
    path.join(bin, 'curl'),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = -d ]; then printf "%s" "$2" > "$MNDW_ROOT/curl-body"; fi\n  shift\ndone\n',
  );
  fs.chmodSync(path.join(bin, 'curl'), 0o755);

  return {root, bin};
};

const runHook = (root: string, bin: string, testCase: HookCase): string => {
  const script = path.join(repoRoot, 'build', 'packaging', 'hooks', 'ndm', testCase.hook, '10-mndw');
  const result = spawnSync('sh', [script, ...testCase.args], {
    cwd: repoRoot,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: root,
      MNDW_ROOT: root,
      MNDW_PORT_FILE: path.join(root, 'var', 'lib', 'mndw', 'frontend-port'),
      ...testCase.env,
    },
    encoding: 'utf8',
  });

  expect(result.status, result.stderr).toBe(0);

  return fs.readFileSync(path.join(root, 'curl-body'), 'utf8');
};

const assertContractBody = (body: string, testCase: HookCase): void => {
  let actualBody: unknown;

  expect(() => {
    actualBody = JSON.parse(body) as unknown;
  }).not.toThrow();
  expect(actualBody).toEqual(testCase.body);
};

const assertExpectedFiles = (root: string, expectedFiles?: Record<string, string | null>): void => {
  for (const [file, contents] of Object.entries(expectedFiles ?? {})) {
    const filePath = path.join(root, file);

    if (contents === null) {
      expect(fs.existsSync(filePath)).toBe(false);
    } else {
      expect(fs.readFileSync(filePath, 'utf8')).toBe(contents);
    }
  }
};

describe('NDMS hook scripts', () => {
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fs.rmSync(fixture, {recursive: true, force: true});
    }
  });

  for (const testCase of cases) {
    it(`matches the ${testCase.name} contract`, () => {
      const {root, bin} = createHookRoot();

      for (const [file, contents] of Object.entries(testCase.files ?? {})) {
        const filePath = path.join(root, file);

        fs.mkdirSync(path.dirname(filePath), {recursive: true});
        fs.writeFileSync(filePath, contents);
      }

      assertContractBody(runHook(root, bin, testCase), testCase);
      assertExpectedFiles(root, testCase.expectedFiles);
    });
  }

  it('uses the interface saved by WAN start when stop omits it, then removes the saved interface', () => {
    const {root, bin} = createHookRoot();
    const start = hookCase('wan-start');
    const stop = hookCase('wan-stop-no-interface');

    assertContractBody(runHook(root, bin, start), start);
    assertExpectedFiles(root, start.expectedFiles);
    assertContractBody(runHook(root, bin, stop), stop);
    assertExpectedFiles(root, stop.expectedFiles);
  });
});
