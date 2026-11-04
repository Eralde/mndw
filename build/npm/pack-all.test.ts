import {describe, expect, it} from 'vitest';
import {basename, dirname} from 'node:path';
import {createPackPlan} from './pack-all.js';

const fixtureManifest = (path: string): {name: string; version: string} => {
  return {name: `@mndw/${basename(dirname(path))}`, version: '1.0.0'};
};

describe('createPackPlan', () => {
  it('clears generated outputs and includes all twelve published packages', () => {
    const plan = createPackPlan('/repo', fixtureManifest);

    expect(plan.cleanPaths).toContain('/repo/out/npm/tarballs');
    expect(plan.cleanPaths).toContain('/repo/frontend/ui/src/icon/generated');
    expect(plan.cleanPaths).toContain('/repo/frontend/host/dist-dev-host');
    expect(plan.cleanPaths).toContain('/repo/tooling/cli/host-dev');
    expect(plan.packages).toHaveLength(12);
    expect(plan.packages.map((pkg) => pkg.name)).toEqual([
      '@mndw/mndwd-darwin-arm64',
      '@mndw/mndwd-darwin-x64',
      '@mndw/mndwd-linux-x64',
      '@mndw/mndwd-linux-arm64',
      '@mndw/mndwd-win32-x64',
      '@mndw/palette-core',
      '@mndw/sdk',
      '@mndw/ui',
      '@mndw/ui-svelte',
      '@mndw/ui-vue',
      '@mndw/ui-angular',
      '@mndw/cli',
    ]);
  });

  it('derives expected npm tarball names and CLI tarball path', () => {
    const plan = createPackPlan('/repo', fixtureManifest);

    expect(plan.tarballs).toContain('/repo/out/npm/tarballs/mndw-cli-1.0.0.tgz');
    expect(plan.tarballs).toContain('/repo/out/npm/tarballs/mndw-mndwd-linux-arm64-1.0.0.tgz');
    expect(plan.cliTarball).toBe('/repo/out/npm/tarballs/mndw-cli-1.0.0.tgz');
  });
});
