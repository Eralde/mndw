import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {validateManifest} from '@mndw/sdk';
import {beforeAll, describe, expect, it} from 'vitest';
import {buildExamplePlugins} from '../../../tools/build-example-plugins.js';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
let outDir: string;
let names: string[];

beforeAll(async () => {
  outDir = mkdtempSync(path.join(tmpdir(), 'mndw-plugins-'));
  names = await buildExamplePlugins({outDir, sourceDir: path.join(repoRoot, 'example-plugins')});
}, 60_000);

function bundle(name: string): string {
  return readFileSync(path.join(outDir, name, 'index.js'), 'utf8');
}

describe('buildExamplePlugins', () => {
  it('builds all three example plugins', () => {
    expect(names.sort()).toEqual(['broken-widget', 'demo-page', 'device-traffic-widget']);
    for (const n of names) {
      expect(existsSync(path.join(outDir, n, 'index.js'))).toBe(true);
      expect(existsSync(path.join(outDir, n, 'manifest.json'))).toBe(true);
    }
  });

  it('keeps shared runtime deps external (import statements, not inlined)', () => {
    // rxjs is a value import in the widget, so it must survive as an external import.
    // (@rci-tools/core is type-only here, so esbuild correctly erases it entirely.)
    const js = bundle('device-traffic-widget');
    expect(js).toMatch(/from\s*["']rxjs["']/);
    expect(js).not.toMatch(/["']@rci-tools\/core["']/);
  });

  it('inlines d3 into the widget bundle', () => {
    const js = bundle('device-traffic-widget');
    // d3 has no shared bundle, so it must NOT be an external import ...
    expect(js).not.toMatch(/from\s*["']d3["']/);
    // ... and its source must actually be present (bundled in).
    expect(js).toContain('d3-selection');
  });

  it('emits a stylesheet for the Svelte widget', () => {
    expect(existsSync(path.join(outDir, 'device-traffic-widget', 'index.css'))).toBe(true);
  });

  it('copies through a valid v2 manifest for each plugin', () => {
    for (const n of names) {
      const m = JSON.parse(readFileSync(path.join(outDir, n, 'manifest.json'), 'utf8'));
      expect(() => validateManifest(m)).not.toThrow();
    }
  });
});
