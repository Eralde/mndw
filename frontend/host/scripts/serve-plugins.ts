import fs from 'node:fs';
import path from 'node:path';
import type {IncomingMessage, ServerResponse} from 'node:http';

/** Dev static roots for plugin assets: builtin vs. user plugins. */
export interface PluginServeDirs {
  builtinDir: string;
  userDir: string;
}

export interface PluginServeMiddlewareDeps {
  readFile?: (filePath: string, callback: (error: NodeJS.ErrnoException | null, content?: Buffer) => void) => void;
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

/** Creates dev-only middleware that reads plugin artifacts afresh for every request. */
export function createPluginServeMiddleware(
  dirs: PluginServeDirs,
  deps: PluginServeMiddlewareDeps = {},
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const readFile = deps.readFile ?? fs.readFile;

  return (req, res, next): void => {
    const resolved = req.url ? resolvePluginRequest(req.url, dirs) : null;

    if (!resolved) {
      next();

      return;
    }

    readFile(resolved.filePath, (error, content) => {
      if (error || content === undefined) {
        next();

        return;
      }

      res.setHeader('Content-Type', resolved.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.end(content);
    });
  };
}
