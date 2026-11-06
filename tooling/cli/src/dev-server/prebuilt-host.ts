import {createReadStream, readFileSync, statSync} from 'node:fs';
import {extname, relative, resolve, sep} from 'node:path';

import type {Plugin} from 'vite';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const LOOPBACK_ORIGIN = /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);

  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

function existingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function addLoopbackCorsHeaders(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
): void {
  const origin = request.headers.origin;

  response.setHeader('Vary', 'Origin');

  if (typeof origin === 'string' && LOOPBACK_ORIGIN.test(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
  }
}

function sendStaticFile(path: string, response: import('node:http').ServerResponse): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', CONTENT_TYPES[extname(path)] ?? 'application/octet-stream');
  createReadStream(path).pipe(response);
}

/** Serves prebuilt host assets and history routes ahead of Vite's plugin-root middleware. */
export function prebuiltHost(dir: string): Plugin {
  const hostRoot = resolve(dir);

  return {
    name: 'mndw-dev-prebuilt-host',
    configureServer(server) {
      const pluginRoot = resolve(server.config.root);

      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' || request.url === undefined) {
          next();

          return;
        }

        const rawPath = request.url.split('?', 1)[0] ?? '/';
        let pathname: string;

        try {
          pathname = decodeURIComponent(rawPath);
        } catch {
          response.statusCode = 404;
          response.end();

          return;
        }

        const hostPath = resolve(hostRoot, `.${pathname}`);

        if (!isWithin(hostRoot, hostPath)) {
          response.statusCode = 404;
          response.end();

          return;
        }

        if (pathname === '/') {
          void sendIndex(request.url, response, server, hostRoot);

          return;
        }

        if (pathname.startsWith('/assets/') || pathname.startsWith('/shared/')) {
          addLoopbackCorsHeaders(request, response);

          if (existingFile(hostPath)) {
            sendStaticFile(hostPath, response);

            return;
          }

          next();

          return;
        }

        const pluginPath = resolve(pluginRoot, `.${pathname}`);

        if (existingFile(hostPath) || existingFile(pluginPath)) {
          next();

          return;
        }

        if ((request.headers.accept ?? '').includes('text/html')) {
          void sendIndex(request.url, response, server, hostRoot);

          return;
        }

        next();
      });
    },
  };
}

async function sendIndex(
  url: string,
  response: import('node:http').ServerResponse,
  server: import('vite').ViteDevServer,
  hostRoot: string,
): Promise<void> {
  const indexPath = resolve(hostRoot, 'index.html');

  if (!isWithin(hostRoot, indexPath) || !existingFile(indexPath)) {
    response.statusCode = 404;
    response.end();

    return;
  }

  try {
    const sourceHtml = readFileSync(indexPath, 'utf8');
    const htmlWithIgnoredAssets = sourceHtml.replace(
      /<script\b(?=[^>]*\btype\s*=\s*["']module["'])(?=[^>]*\bsrc\s*=\s*["']\/assets\/)(?![^>]*\bvite-ignore\b)[^>]*>/gi,
      (script) => script.replace(/^<script\b/i, '<script vite-ignore'),
    );
    const html = await server.transformIndexHtml(url, htmlWithIgnoredAssets);

    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
  } catch {
    response.statusCode = 500;
    response.end('Failed to transform prebuilt host index.html');
  }
}
