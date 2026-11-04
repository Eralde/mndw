import type {SandboxImports} from './sandbox-loader.js';
import {scheduleSandboxReload} from './sandbox-virtual.js';
import type {HostServices} from '../host-services.js';

export const DEV_PLUGIN_URL = '/@mndw-dev/plugin.js';
export const DEV_MANIFEST_URL = '/@mndw-dev/manifest.js';
export const DEV_PLUGIN_UPDATE_EVENT = 'mndw:dev-plugin-update';
export const DEV_MANIFEST_UPDATE_EVENT = 'mndw:dev-manifest-update';

type SandboxUrlImporter = (url: string) => Promise<unknown>;

const defaultImporter: SandboxUrlImporter = (url) => import(/* @vite-ignore */ url);

export function sandboxUrlImports(importer: SandboxUrlImporter = defaultImporter): SandboxImports {
  return {
    importPluginModule: () => importer(DEV_PLUGIN_URL),
    importManifestModule: async () =>
      await importer(DEV_MANIFEST_URL) as {
        default?: unknown;
        __catalogBaseUrl?: string;
      },
  };
}

export function setupSandboxUrlHmr(services: HostServices, target: EventTarget = window): void {
  const updates = scheduleSandboxReload(services, sandboxUrlImports());

  target.addEventListener(DEV_PLUGIN_UPDATE_EVENT, (event) => {
    updates.plugin((event as CustomEvent<unknown>).detail);
  });
  target.addEventListener(DEV_MANIFEST_UPDATE_EVENT, (event) => {
    updates.manifest((event as CustomEvent<unknown>).detail);
  });
}
