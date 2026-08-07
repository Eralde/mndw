import fs from 'node:fs';
import path from 'node:path';
import type {ModuleNode, Plugin} from 'vite';

/** Virtual module ids the sandbox loader imports at runtime. */
export const SANDBOX_PLUGIN_MODULE_ID = 'virtual:sandbox-plugin';
export const SANDBOX_MANIFEST_MODULE_ID = 'virtual:sandbox-manifest';

const RESOLVED_PLUGIN_ID = '\0' + SANDBOX_PLUGIN_MODULE_ID;
const RESOLVED_MANIFEST_ID = '\0' + SANDBOX_MANIFEST_MODULE_ID;

/** Filesystem operations, injectable so the pure renderers are unit-testable. */
export interface SandboxFsDeps {
  existsSync: (filePath: string) => boolean;
  readFileSync: (filePath: string) => string;
}

const defaultFs: SandboxFsDeps = {
  existsSync: (filePath) => fs.existsSync(filePath),
  readFileSync: (filePath) => fs.readFileSync(filePath, 'utf-8'),
};

/**
 * Resolves the sandbox plugin directory from the explicit `MNDW_SANDBOX_PLUGIN` value,
 * relative to the repo root. Returns null when unset — the only trigger for sandbox mode,
 * so normal host startup is never affected.
 */
export function resolveSandboxPluginPath(rawPath: string | undefined, repoRoot: string): string | null {
  if (!rawPath) {
    return null;
  }

  return path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
}

/** Source for `virtual:sandbox-plugin`: re-exports `createInstance` from the plugin source entry. */
export function renderSandboxModule(resolvedPath: string): string {
  const entry = path.join(resolvedPath, 'src', 'index.ts');

  return `export {createInstance} from ${JSON.stringify(entry)};`;
}

/**
 * Source for `virtual:sandbox-manifest`: the parsed manifest as the default export. Throws
 * visibly when the manifest is missing or malformed so the loader never registers a fake
 * plugin over a real authoring error.
 */
export function renderSandboxManifest(resolvedPath: string, deps: SandboxFsDeps = defaultFs): string {
  const manifestPath = path.join(resolvedPath, 'manifest.json');

  if (!deps.existsSync(manifestPath)) {
    throw new Error(`[mndw-sandbox] No manifest.json found at ${manifestPath}`);
  }

  const raw = deps.readFileSync(manifestPath);

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[mndw-sandbox] manifest.json is not valid JSON: ${(err as Error).message}`);
  }

  return `export default ${JSON.stringify(parsed)};`;
}

/** True when a changed file belongs to the sandbox plugin directory (source or manifest). */
export function isSandboxFile(file: string, resolvedPath: string): boolean {
  return file === resolvedPath || file.startsWith(resolvedPath + path.sep);
}

// Inert virtual modules served in a normal (non-sandbox) build so Rollup can still resolve
// the `virtual:sandbox-*` dynamic imports reachable from the app; the runtime never loads
// them because the `__MNDW_SANDBOX__` flag is false.
const INERT_PLUGIN_MODULE = 'export const createInstance = undefined;';
const INERT_MANIFEST_MODULE = 'export default null;';

/**
 * Vite plugin exposing the sandbox plugin's source and manifest as virtual modules. It is
 * always registered so the two virtual ids resolve in every build; when no sandbox path is
 * configured it serves inert stubs and does not whitelist any directory or wire HMR. With a
 * path it serves the real source/manifest, allows the plugin dir on the dev server, and
 * invalidates both virtual modules on any change (driving the runtime HMR transaction).
 */
export function sandboxPlugin(resolvedPath: string | null, deps: SandboxFsDeps = defaultFs): Plugin {
  return {
    name: 'mndw-sandbox',
    enforce: 'pre',
    resolveId(id) {
      if (id === SANDBOX_PLUGIN_MODULE_ID) {
        return RESOLVED_PLUGIN_ID;
      }

      if (id === SANDBOX_MANIFEST_MODULE_ID) {
        return RESOLVED_MANIFEST_ID;
      }

      return undefined;
    },
    load(id) {
      if (id === RESOLVED_PLUGIN_ID) {
        return resolvedPath === null ? INERT_PLUGIN_MODULE : renderSandboxModule(resolvedPath);
      }

      if (id === RESOLVED_MANIFEST_ID) {
        return resolvedPath === null ? INERT_MANIFEST_MODULE : renderSandboxManifest(resolvedPath, deps);
      }

      return undefined;
    },
    config() {
      return resolvedPath === null ? {} : {server: {fs: {allow: [resolvedPath]}}};
    },
    handleHotUpdate({file, server}) {
      if (resolvedPath === null || !isSandboxFile(file, resolvedPath)) {
        return undefined;
      }

      const affected = [RESOLVED_PLUGIN_ID, RESOLVED_MANIFEST_ID]
        .map((id) => server.moduleGraph.getModuleById(id))
        .filter((mod): mod is ModuleNode => mod != null);

      for (const mod of affected) {
        server.moduleGraph.invalidateModule(mod);
      }

      return affected;
    },
  };
}
