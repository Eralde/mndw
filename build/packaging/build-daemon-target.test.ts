import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {buildDaemonTarget} from '../../daemon/mndwd/scripts/build-target.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

describe('buildDaemonTarget', () => {
  let outputDirectory: string;

  afterEach(() => {
    rmSync(outputDirectory, {recursive: true, force: true});
  });

  it('passes the HTTP/2 omission build tag to go build', () => {
    const outputPathRoot = mkdtempSync(join(tmpdir(), 'mndw-daemon-build-test-'));

    outputDirectory = outputPathRoot;

    let capturedArgs: readonly string[] = [];
    const spawn = ((_command: string, args: readonly string[]) => {
      capturedArgs = args;

      return {status: 0};
    }) as unknown as typeof spawnSync;

    buildDaemonTarget({
      repoRoot: REPO_ROOT,
      target: 'aarch64',
      outputPath: join(outputPathRoot, 'mndwd'),
      version: 'test',
      spawn,
    });

    const tagIndex = capturedArgs.indexOf('-tags');

    expect(capturedArgs.slice(tagIndex, tagIndex + 2)).toEqual(['-tags', 'nethttpomithttp2']);
  });
});
