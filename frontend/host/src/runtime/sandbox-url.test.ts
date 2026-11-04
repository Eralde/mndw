import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('./sandbox-loader.js', () => ({
  reloadSandboxPlugin: vi.fn(() => Promise.resolve('reloaded')),
}));

import {type SandboxLoaderDeps, reloadSandboxPlugin} from './sandbox-loader.js';
import {
  DEV_MANIFEST_UPDATE_EVENT,
  DEV_MANIFEST_URL,
  DEV_PLUGIN_UPDATE_EVENT,
  DEV_PLUGIN_URL,
  sandboxUrlImports,
  setupSandboxUrlHmr,
} from './sandbox-url.js';
import {createHostServices} from '../host-services.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function reloadImports(): SandboxLoaderDeps | undefined {
  return vi.mocked(reloadSandboxPlugin).mock.calls[0]?.[0];
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('sandboxUrlImports', () => {
  it('imports the plugin and manifest modules from their dev URLs', async () => {
    const pluginModule = {createInstance: vi.fn()};
    const manifestModule = {default: {name: 'demo'}};
    const importer = vi.fn((url: string) => Promise.resolve(url === DEV_PLUGIN_URL ? pluginModule : manifestModule));
    const imports = sandboxUrlImports(importer);

    await expect(imports.importPluginModule()).resolves.toBe(pluginModule);
    await expect(imports.importManifestModule()).resolves.toBe(manifestModule);
    expect(importer.mock.calls).toEqual([[DEV_PLUGIN_URL], [DEV_MANIFEST_URL]]);
  });
});

describe('setupSandboxUrlHmr', () => {
  it('reloads with the plugin module carried by its update event', async () => {
    const target = new EventTarget();
    const services = createHostServices();
    const freshPlugin = {createInstance: vi.fn()};

    setupSandboxUrlHmr(services, target);
    target.dispatchEvent(new CustomEvent(DEV_PLUGIN_UPDATE_EVENT, {detail: freshPlugin}));
    await flushMicrotasks();

    expect(reloadSandboxPlugin).toHaveBeenCalledTimes(1);
    await expect(reloadImports()?.importPluginModule?.()).resolves.toBe(freshPlugin);
  });

  it('coalesces plugin and manifest updates dispatched in the same tick', async () => {
    const target = new EventTarget();
    const services = createHostServices();
    const freshPlugin = {createInstance: vi.fn()};
    const freshManifest = {default: {name: 'fresh'}};

    setupSandboxUrlHmr(services, target);
    target.dispatchEvent(new CustomEvent(DEV_PLUGIN_UPDATE_EVENT, {detail: freshPlugin}));
    target.dispatchEvent(new CustomEvent(DEV_MANIFEST_UPDATE_EVENT, {detail: freshManifest}));
    await flushMicrotasks();

    expect(reloadSandboxPlugin).toHaveBeenCalledTimes(1);

    const imports = reloadImports();

    await expect(imports?.importPluginModule?.()).resolves.toBe(freshPlugin);
    await expect(imports?.importManifestModule?.()).resolves.toBe(freshManifest);
  });
});
