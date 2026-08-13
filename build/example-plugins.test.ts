import {mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe, expect, it} from 'vitest';
import {EXAMPLE_TARGETS, buildExamplePlugins, expectedExampleArchiveNames} from './example-plugins.js';

describe('example plugin distribution', () => {
  it('defines one traffic archive and one self-describing ping archive per target', () => {
    expect(EXAMPLE_TARGETS).toEqual(['aarch64', 'mips', 'mipsel']);
    expect(expectedExampleArchiveNames()).toEqual([
      'device-traffic-widget.zip',
      'ping-widget-aarch64.zip',
      'ping-widget-mips.zip',
      'ping-widget-mipsel.zip',
    ]);
  });

  it('publishes only zip files and removes stale output artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mndw-example-plugin-test-'));
    const outputRoot = join(root, 'example-plugins');

    mkdirSync(outputRoot);
    writeFileSync(join(outputRoot, 'stale-artifact.txt'), 'stale artifact');

    try {
      await buildExamplePlugins({outputRoot});

      expect(readdirSync(outputRoot).sort()).toEqual(expectedExampleArchiveNames().sort());
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});
