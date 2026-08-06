import {SHARED_DEPENDENCIES} from '@mndw/sdk/shared-dependencies';
import {build} from 'esbuild';
import {describe, expect, it} from 'vitest';

const entry = SHARED_DEPENDENCIES.find((candidate) => candidate.bundle === 'mndw-ui');

describe('mndw-ui shared bundle', () => {
  it('is registered for every framework', () => {
    expect(entry).toBeDefined();
    expect(entry?.framework).toBe('base');
    expect(entry?.specifiers).toEqual(['@mndw/ui']);
  });

  it('declares D3 as an external host dependency', () => {
    expect(entry?.external).toEqual(['d3']);
  });

  it('bundles with Lit inlined and D3 as the only runtime import', async () => {
    const result = await build({
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      entryPoints: ['@mndw/ui'],
      external: entry?.external,
      metafile: true,
    });

    const output = Object.values(result.metafile?.outputs ?? {})[0];

    expect(output.imports.filter((item) => item.external).map((item) => item.path)).toEqual(['d3']);
    expect(result.outputFiles[0].text).toContain('mndw-select');
  }, 30000);
});
