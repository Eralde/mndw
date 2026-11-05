import fs from 'node:fs';
import path from 'node:path';

/** Filesystem operations, injectable so the pure renderers are unit-testable. */
export interface SandboxFsDeps {
  existsSync: (filePath: string) => boolean;
  readFileSync: (filePath: string) => string;
}

const defaultFs: SandboxFsDeps = {
  existsSync: (filePath) => fs.existsSync(filePath),
  readFileSync: (filePath) => fs.readFileSync(filePath, 'utf-8'),
};

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

  const catalogBaseUrl = `/@fs${resolvedPath.replace(/\/$/, '')}`;

  return `export const __catalogBaseUrl = ${JSON.stringify(catalogBaseUrl)};\nexport default ${
    JSON.stringify(parsed)
  };`;
}
