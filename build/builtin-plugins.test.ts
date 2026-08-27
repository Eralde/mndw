import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  type BuiltinBuilderOptions,
  type CommandStep,
  buildBackend,
  buildFrontend,
  buildOne,
  discoverBuiltinPlugins,
  runPool,
} from './builtin-plugins.js';

function fixturePlugin(): {root: string; sourceRoot: string; distRoot: string; pluginDir: string} {
  const root = mkdtempSync(join(tmpdir(), 'mndw-builtin-test-'));
  const sourceRoot = join(root, 'builtin');
  const distRoot = join(sourceRoot, 'dist');
  const pluginDir = join(sourceRoot, 'sample');

  mkdirSync(pluginDir, {recursive: true});
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      scripts: {build: 'vite build'},
      mndw: {backendBuildScript: 'build-backend'},
    }),
  );

  return {root, sourceRoot, distRoot, pluginDir};
}

function cleanupFixture(root: string): void {
  rmSync(root, {recursive: true, force: true});
}

function stepRecorder(steps: CommandStep[]): (step: CommandStep) => Promise<string> {
  return (step) => {
    steps.push(step);

    return Promise.resolve('');
  };
}

function stepAt(steps: readonly CommandStep[], index: number): CommandStep {
  const step = steps[index];

  if (step === undefined) {
    throw new Error(`missing step ${index}`);
  }

  return step;
}

function argsText(step: CommandStep): string {
  return [step.command, ...step.args].join(' ');
}

describe('built-in plugin discovery', () => {
  it('does not discover moved uploadable examples', () => {
    const names = discoverBuiltinPlugins();

    expect(names).not.toContain('ping-widget');
    expect(names).not.toContain('device-traffic-widget');
    expect(names.length).toBeGreaterThan(0);
  });
});

describe('granular built-in builders', () => {
  it('buildFrontend runs frontend build/pack steps with backend hook skipped', async () => {
    const fixture = fixturePlugin();
    const steps: CommandStep[] = [];

    writeFileSync(join(fixture.pluginDir, 'package.json'), JSON.stringify({scripts: {build: 'vite build'}}));

    try {
      await buildFrontend('sample', {sourceRoot: fixture.sourceRoot, distRoot: fixture.distRoot}, {
        runStep: stepRecorder(steps),
        promote: vi.fn(),
      });

      expect(steps).toHaveLength(2);
      expect(argsText(stepAt(steps, 0))).toContain('pnpm run build');
      expect(argsText(stepAt(steps, 1))).toContain('--skip-backend-build');
      expect(steps.map(argsText).join('\n')).not.toContain('pnpm run build-backend');
    } finally {
      cleanupFixture(fixture.root);
    }
  });

  it('buildBackend runs backend hook then packs current frontend/backend assets', async () => {
    const fixture = fixturePlugin();
    const steps: CommandStep[] = [];

    try {
      await buildBackend('sample', {sourceRoot: fixture.sourceRoot, distRoot: fixture.distRoot}, {
        runStep: stepRecorder(steps),
        promote: vi.fn(),
      });

      expect(steps).toHaveLength(2);
      expect(argsText(stepAt(steps, 0))).toContain('pnpm run build-backend');
      expect(argsText(stepAt(steps, 1))).toContain('--skip-backend-build');
    } finally {
      cleanupFixture(fixture.root);
    }
  });

  it('buildOne preserves the complete all-plugin step sequence', async () => {
    const fixture = fixturePlugin();
    const steps: CommandStep[] = [];

    writeFileSync(join(fixture.pluginDir, 'package.json'), JSON.stringify({scripts: {build: 'vite build'}}));

    try {
      await buildOne('sample', {sourceRoot: fixture.sourceRoot, outputRoot: join(fixture.root, 'stage')}, {
        runStep: stepRecorder(steps),
      });

      expect(steps).toHaveLength(2);
      expect(argsText(stepAt(steps, 0))).toContain('pnpm run build');
      expect(argsText(stepAt(steps, 1))).not.toContain('--skip-backend-build');
    } finally {
      cleanupFixture(fixture.root);
    }
  });

  it('promotes only the named granular plugin after successful steps', async () => {
    const fixture = fixturePlugin();
    const promote = vi.fn();

    try {
      await buildFrontend('sample', {sourceRoot: fixture.sourceRoot, distRoot: fixture.distRoot}, {
        runStep: () => Promise.resolve(''),
        promote,
      });

      expect(promote).toHaveBeenCalledWith(
        expect.stringMatching(/mndw-builtin-granular-[^/]+\/sample$/),
        join(fixture.distRoot, 'sample'),
      );
    } finally {
      cleanupFixture(fixture.root);
    }
  });

  it('leaves named dist output untouched when a granular step fails', async () => {
    const fixture = fixturePlugin();
    const existing = join(fixture.distRoot, 'sample');
    mkdirSync(existing, {recursive: true});
    writeFileSync(join(existing, 'marker'), 'last-good');
    const promote = vi.fn();

    try {
      await expect(buildBackend('sample', {sourceRoot: fixture.sourceRoot, distRoot: fixture.distRoot}, {
        runStep: () => Promise.reject(new Error('failed build')),
        promote,
      })).rejects.toThrow('failed build');

      expect(promote).not.toHaveBeenCalled();
      expect(readFileSync(join(existing, 'marker'), 'utf8')).toBe('last-good');
    } finally {
      cleanupFixture(fixture.root);
    }
  });

  it('all-plugin worker delegates to buildOne before final root promotion', async () => {
    const buildOneFn = vi.fn<(name: string, options: BuiltinBuilderOptions) => Promise<void>>().mockResolvedValue(
      undefined,
    );
    const options: BuiltinBuilderOptions = {sourceRoot: '/source', outputRoot: '/staged', development: true};

    await runPool(['one', 'two'], options, 1, buildOneFn);

    expect(buildOneFn).toHaveBeenNthCalledWith(1, 'one', options);
    expect(buildOneFn).toHaveBeenNthCalledWith(2, 'two', options);
  });
});
