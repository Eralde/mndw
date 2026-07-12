import path from 'node:path';

/** Dev static roots for plugin assets (design §6): builtin vs. user plugins. */
export interface PluginServeDirs {
  builtinDir: string;
  userDir: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
};

/**
 * Resolves a dev request for a plugin asset to an on-disk path + content-type, or null
 * when the URL is not a plugin request or would escape its base dir. Pure (no fs) so it
 * is unit-testable; the vite middleware does the file read.
 */
export function resolvePluginRequest(
  reqUrl: string,
  dirs: PluginServeDirs,
): {filePath: string; contentType: string} | null {
  const pathname = reqUrl.split('?')[0];

  let base: string;
  let rest: string;

  if (pathname.startsWith('/plugins/')) {
    base = dirs.builtinDir;
    rest = pathname.slice('/plugins/'.length);
  } else if (pathname.startsWith('/user-plugins/')) {
    base = dirs.userDir;
    rest = pathname.slice('/user-plugins/'.length);
  } else {
    return null;
  }

  const filePath = path.resolve(base, rest);

  // Safe-join: the resolved path must stay within the base dir.
  if (filePath !== base && !filePath.startsWith(base + path.sep)) {
    return null;
  }

  const contentType = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';

  return {filePath, contentType};
}
