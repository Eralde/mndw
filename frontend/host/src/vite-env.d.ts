/// <reference types="svelte" />
/// <reference types="vite/client" />

// Sandbox virtual modules, provided by the opt-in `mndw-sandbox` Vite plugin only when
// `mndw dev` sets MNDW_SANDBOX_PLUGIN. Absent in normal host startup.
declare module 'virtual:sandbox-plugin' {
  import type {MndwPlugin} from '@mndw/sdk';
  export const createInstance: MndwPlugin['createInstance'];
}

declare module 'virtual:sandbox-manifest' {
  const manifest: Record<string, unknown>;
  export const __catalogBaseUrl: string | undefined;
  export default manifest;
}

// Injected by vite.config `define`: virtual for repo dev, url for the prebuilt dev host,
// false for regular host builds. Guard reads with `typeof` under vitest.
declare const __MNDW_SANDBOX__: false | 'virtual' | 'url' | undefined;
declare const __MNDW_PSEUDO_LOCALE_ENABLED__: boolean | undefined;
