import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {SHARED_DEPENDENCIES} from '@mndw/sdk-internal/shared-dependencies';
import {type BuildResult, build} from 'esbuild';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const d3Entry = SHARED_DEPENDENCIES.find((entry) => entry.bundle === 'd3');

if (d3Entry === undefined) {
  throw new Error('Missing shared d3 entry');
}

let tempDir: string;
let bundlePath: string;
let result: BuildResult;

beforeAll(async () => {
  tempDir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mndw-d3-bundle-'));
  bundlePath = join(tempDir, `d3@${d3Entry.version}.mjs`);
  result = await build({
    bundle: true,
    entryPoints: [d3Entry.entryPoint ?? d3Entry.bundle],
    format: 'esm',
    metafile: true,
    outfile: bundlePath,
    platform: 'browser',
    target: 'es2022',
  });
});

afterAll(() => {
  rmSync(tempDir, {recursive: true, force: true});
});

async function loadD3Bundle(): Promise<Record<string, unknown>> {
  const source = readFileSync(bundlePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

  return await import(dataUrl) as Record<string, unknown>;
}

describe('host-provided full d3 bundle', () => {
  it('contains representative APIs from the full d3 package', async () => {
    const d3 = await loadD3Bundle();

    for (
      const exportName of [
        'select',
        'scaleLinear',
        'axisBottom',
        'line',
        'geoPath',
        'forceSimulation',
        'zoom',
        'transition',
      ]
    ) {
      expect(typeof d3[exportName], exportName).toBe('function');
    }
  });

  it('keeps d3-selection transition methods on the full bundle selection prototype', async () => {
    const d3 = await loadD3Bundle();
    const select = d3.select as (node: null) => {interrupt?: unknown};

    expect(typeof select(null).interrupt).toBe('function');
  });

  it('does not leave the d3 package as an unresolved import', () => {
    const output = readFileSync(bundlePath, 'utf8');

    expect(output).not.toMatch(/from\s*["']d3["']/);
    expect(result.metafile && Object.keys(result.metafile.inputs).some((input) => input.includes('/node_modules/d3/')))
      .toBe(
        true,
      );
  });
});
