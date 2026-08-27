import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

export interface ReloadSentinel {
  readonly path: string;
  touch(): void;
  cleanup(): void;
}

export interface ReloadSentinelDeps {
  readonly makeDir?: (dir: string) => void;
  readonly makeSessionDir?: (prefix: string) => string;
  readonly writeFile?: (path: string, contents: string) => void;
  readonly removeDir?: (dir: string) => void;
}

export interface RestartServiceOptions {
  readonly daemonUrl: string;
  readonly pluginName: string;
  readonly timeoutMs?: number;
}

export interface RestartServiceDeps {
  readonly fetch?: typeof fetch;
}

/** Creates one repo-local, per-session file whose changing contents signal a completed rebuild. */
export function createReloadSentinel(repoRoot: string, deps: ReloadSentinelDeps = {}): ReloadSentinel {
  const makeDir = deps.makeDir ?? ((dir) => mkdirSync(dir, {recursive: true}));
  const makeSessionDir = deps.makeSessionDir ?? ((prefix) => mkdtempSync(prefix));
  const writeFile = deps.writeFile ?? ((path, contents) => writeFileSync(path, contents));
  const removeDir = deps.removeDir ?? ((dir) => rmSync(dir, {recursive: true, force: true}));
  const parentDir = join(resolve(repoRoot), '.dev-data', 'mndw-dev-reload');

  makeDir(parentDir);

  const sessionDir = makeSessionDir(join(parentDir, 'session-'));
  const sentinelPath = join(sessionDir, 'sentinel');
  let counter = 0;
  let cleaned = false;

  writeFile(sentinelPath, '0\n');

  return {
    path: sentinelPath,
    touch: (): void => {
      counter++;
      writeFile(sentinelPath, `${counter}\n`);
    },
    cleanup: (): void => {
      if (cleaned) {
        return;
      }

      cleaned = true;

      try {
        removeDir(sessionDir);
      } catch {
        // Runtime cleanup is best-effort.
      }
    },
  };
}

/** Restarts one service plugin and reports success only when management returns HTTP 200. */
export async function restartService(
  options: RestartServiceOptions,
  deps: RestartServiceDeps = {},
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  const daemonUrl = options.daemonUrl.replace(/\/$/, '');

  try {
    const response = await (deps.fetch ?? fetch)(
      `${daemonUrl}/api/mgmt/restart`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: options.pluginName}),
        signal: controller.signal,
      },
    );

    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
