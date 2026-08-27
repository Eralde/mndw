import path from 'node:path';
import type {Plugin, ViteDevServer} from 'vite';

const RELOAD_DEBOUNCE_MS = 50;

/** Connects one session sentinel to Vite's browser full-reload channel. */
export function reloadOnSentinel(sentinelPath: string): Plugin {
  const configuredPath = path.resolve(sentinelPath);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const handleEvent = (changedPath: string, server: ViteDevServer): void => {
    if (path.resolve(changedPath) !== configuredPath || timer !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      server.ws.send({type: 'full-reload'});
    }, RELOAD_DEBOUNCE_MS);
  };

  return {
    name: 'mndw-reload-on-sentinel',
    configureServer(server) {
      server.watcher.add(configuredPath);
      server.watcher.on('add', (changedPath) => handleEvent(changedPath, server));
      server.watcher.on('change', (changedPath) => handleEvent(changedPath, server));
    },
  };
}
