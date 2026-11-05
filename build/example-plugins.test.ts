import {mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe, expect, it} from 'vitest';
import {
  EXAMPLE_TARGETS,
  buildExamplePlugins,
  discoverExamplePlugins,
  expectedExampleArchiveNames,
} from './example-plugins.js';

// The full suites run in .github/workflows/ci-weekly.yml.
const skipSlowTests = process.env.MNDW_SKIP_SLOW_TESTS === '1';

describe('example plugin distribution', () => {
  it('discovers every direct example directory with a manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'mndw-example-discovery-test-'));
    const sourceRoot = join(root, 'plugins', 'examples');

    mkdirSync(join(sourceRoot, 'zeta-plugin'), {recursive: true});
    mkdirSync(join(sourceRoot, 'alpha-plugin'), {recursive: true});
    mkdirSync(join(sourceRoot, 'not-a-plugin'), {recursive: true});
    writeFileSync(
      join(sourceRoot, 'zeta-plugin', 'manifest.json'),
      JSON.stringify({name: 'zeta-plugin'}),
    );
    writeFileSync(
      join(sourceRoot, 'alpha-plugin', 'manifest.json'),
      JSON.stringify({name: 'alpha-plugin'}),
    );

    try {
      expect(discoverExamplePlugins(sourceRoot).map((plugin) => plugin.name)).toEqual([
        'alpha-plugin',
        'zeta-plugin',
      ]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it('defines archives for known examples and every backend target', () => {
    expect(EXAMPLE_TARGETS).toEqual(['aarch64', 'mips', 'mipsel']);

    const names = expectedExampleArchiveNames();

    expect(names).toContain('device-traffic-widget.zip');
    expect(names).toContain('hello-widget.zip');
    expect(names).toContain('rci-device-name-widget.zip');

    for (const target of EXAMPLE_TARGETS) {
      expect(names).toContain(`ping-widget-${target}.zip`);
    }
  });

  it.skipIf(skipSlowTests)('publishes only zip files and removes stale output artifacts', async () => {
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
  }, 300_000);
});
