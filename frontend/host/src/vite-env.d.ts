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
  export default manifest;
}

// Injected by vite.config `define`: true only under `mndw dev` sandbox mode. Guard reads
// with `typeof __MNDW_SANDBOX__` so it is safe when undefined (e.g. under vitest).
declare const __MNDW_SANDBOX__: boolean | undefined;
