import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {isBuiltin} from 'node:module';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {runProcess} from './test-process.js';

interface BuildMetadata {
  readonly outputs: Readonly<Record<string, {
    readonly imports?: readonly {readonly path: string; readonly external: boolean}[];
  }>>;
}

interface CliPackage {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const cliRoot = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(cliRoot, 'package.json'), 'utf8')) as CliPackage;
const declaredDependencies = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
]);
const packageName = (specifier: string): string => {
  const parts = specifier.split('/');

  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0] ?? '';
};

describe('publishable CLI bundle dependencies', () => {
  let outDir: string | undefined;

  afterEach(() => {
    if (outDir !== undefined) {
      rmSync(outDir, {recursive: true, force: true});
      outDir = undefined;
    }
  });

  it('declares every external bare import and bundles private workspace internals', async () => {
    outDir = mkdtempSync(resolve(tmpdir(), 'mndw-cli-bundle-'));

    const buildScript = resolve(cliRoot, 'scripts', 'build.ts');
    const build = await runProcess(process.execPath, ['--import', 'tsx', buildScript, '--outdir', outDir], {
      cwd: cliRoot,
    });

    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

    const metadata = JSON.parse(readFileSync(resolve(outDir, 'meta.json'), 'utf8')) as BuildMetadata;
    const externalImports = Object.values(metadata.outputs)
      .flatMap((output) => output.imports ?? [])
      .filter((entry) => entry.external)
      .map((entry) => entry.path)
      .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/') && !isBuiltin(specifier));

    for (const specifier of externalImports) {
      expect(declaredDependencies.has(packageName(specifier)), `${specifier} must be declared as a runtime dependency`)
        .toBe(true);
    }

    expect(externalImports).not.toContain('@mndw/sdk-internal');
    expect(externalImports).not.toContain('@mndw/angular-compiler');
  });
});
