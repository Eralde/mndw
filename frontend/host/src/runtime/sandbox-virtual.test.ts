import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('./sandbox-loader.js', () => ({
  reloadSandboxPlugin: vi.fn(() => Promise.resolve('reloaded')),
}));

import {type SandboxImports, reloadSandboxPlugin} from './sandbox-loader.js';
import {setupSandboxHmr} from './sandbox-virtual.js';
import {createHostServices} from '../host-services.js';

interface FakeHot {
  callbacks: Record<string, (module: unknown) => void>;
  accept: ReturnType<typeof vi.fn>;
}

function fakeHot(): FakeHot {
  const callbacks: Record<string, (module: unknown) => void> = {};
  const accept = vi.fn((dependency: string, callback: (module: unknown) => void) => {
    callbacks[dependency] = callback;
  });

  return {callbacks, accept};
}

function baseImports(previousPlugin: unknown, previousManifest: {default?: unknown}): SandboxImports {
  return {
    importPluginModule: () => Promise.resolve(previousPlugin),
    importManifestModule: () => Promise.resolve(previousManifest),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('setupSandboxHmr', () => {
  it('coalesces plugin and manifest HMR updates and reloads with fresh modules', async () => {
    const hot = fakeHot();
    const previousPlugin = {createInstance: vi.fn()};
    const previousManifest = {default: {name: 'previous'}};
    const freshPlugin = {createInstance: vi.fn()};
    const freshManifest = {default: {name: 'fresh'}};
    const services = createHostServices();

    setupSandboxHmr(services, hot as never, baseImports(previousPlugin, previousManifest));

    hot.callbacks['virtual:sandbox-plugin']?.(freshPlugin);
    hot.callbacks['virtual:sandbox-manifest']?.(freshManifest);
    await flushMicrotasks();

    expect(reloadSandboxPlugin).toHaveBeenCalledTimes(1);

    const imports = vi.mocked(reloadSandboxPlugin).mock.calls[0]?.[0];

    expect(imports).toBeDefined();

    if (imports === undefined) {
      return;
    }

    expect(imports.importPluginModule).toBeDefined();
    expect(imports.importManifestModule).toBeDefined();
    expect(imports.registry).toBe(services.registry);
    expect(imports.catalogService).toBe(services.catalog);
    expect(imports.getLocale?.()).toBe(services.locale.getLocale());

    if (imports.importPluginModule === undefined || imports.importManifestModule === undefined) {
      return;
    }

    await expect(imports.importPluginModule()).resolves.toBe(freshPlugin);
    await expect(imports.importManifestModule()).resolves.toBe(freshManifest);
  });

  it('uses base provider for a manifest that was not updated', async () => {
    const hot = fakeHot();
    const previousPlugin = {createInstance: vi.fn()};
    const previousManifest = {default: {name: 'previous'}};
    const freshPlugin = {createInstance: vi.fn()};
    const services = createHostServices();

    setupSandboxHmr(services, hot as never, baseImports(previousPlugin, previousManifest));

    hot.callbacks['virtual:sandbox-plugin']?.(freshPlugin);
    await flushMicrotasks();

    expect(reloadSandboxPlugin).toHaveBeenCalledTimes(1);

    const imports = vi.mocked(reloadSandboxPlugin).mock.calls[0]?.[0];

    expect(imports).toBeDefined();

    if (imports === undefined) {
      return;
    }

    expect(imports.importPluginModule).toBeDefined();
    expect(imports.importManifestModule).toBeDefined();

    if (imports.importPluginModule === undefined || imports.importManifestModule === undefined) {
      return;
    }

    await expect(imports.importPluginModule()).resolves.toBe(freshPlugin);
    await expect(imports.importManifestModule()).resolves.toBe(previousManifest);
  });
});
