import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Rollup} from 'vite';
import {build} from 'vite';
import {describe, expect, it} from 'vitest';

const FIXTURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h2"/></svg>';

interface BuiltAssets {
  readonly code: string;
  readonly assets: Rollup.OutputAsset[];
}

function isChunk(output: Rollup.OutputChunk | Rollup.OutputAsset): output is Rollup.OutputChunk {
  return output.type === 'chunk';
}

async function buildProbe(entryImports: readonly string[]): Promise<BuiltAssets> {
  const dir = mkdtempSync(join(tmpdir(), 'mndw-icon-asset-'));
  const fixturePath = join(dir, 'fixture.svg');
  const entryPath = join(dir, 'entry.js');
  writeFileSync(fixturePath, FIXTURE_SVG);
  writeFileSync(
    entryPath,
    `${entryImports.map((specifier, index) => `import url${index} from './fixture.svg${specifier}';`).join('\n')}
globalThis.__mndwIconProbe = [${entryImports.map((_specifier, index) => `url${index}`).join(', ')}];
`,
  );

  try {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {write: false, rollupOptions: {input: entryPath}},
    });
    const built = Array.isArray(result) ? result[0] : result;

    if (!('output' in built)) {
      throw new Error('expected a Rollup output result');
    }

    const outputs: (Rollup.OutputChunk | Rollup.OutputAsset)[] = built.output;

    return {
      code: outputs.filter(isChunk).map((chunk) => chunk.code).join('\n'),
      assets: outputs.filter((output): output is Rollup.OutputAsset => output.type === 'asset'),
    };
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

describe('host icon sprite asset', () => {
  it('emits an external SVG asset for sprite imports', async () => {
    const {code, assets} = await buildProbe(['?url&no-inline']);
    const emitted = assets.filter((asset) => asset.fileName.endsWith('.svg'));

    expect(emitted).toHaveLength(1);
    expect(code).toContain(emitted[0].fileName);
    expect(code).not.toContain('data:image/svg+xml');
  });

  it('inlines a bare url import under the default asset threshold', async () => {
    const {code, assets} = await buildProbe(['?url']);

    expect(code).toContain('data:image/svg+xml');
    expect(assets.filter((asset) => asset.fileName.endsWith('.svg'))).toHaveLength(0);
  });
});
