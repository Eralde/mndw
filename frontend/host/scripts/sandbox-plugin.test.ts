import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import type {SandboxFsDeps} from '@mndw/sdk-internal/dev-sandbox';
import {isSandboxFile, resolveSandboxPluginPath, sandboxPlugin} from './sandbox-plugin.js';

const repoRoot = '/repo';
const pluginDir = path.resolve(repoRoot, 'plugins/examples', 'sample-page');

function fakeFs(files: Record<string, string>): SandboxFsDeps {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`ENOENT ${p}`);
      }

      return files[p];
    },
  };
}

const manifestPath = path.join(pluginDir, 'manifest.json');
const validManifest = JSON.stringify({
  manifestVersion: 1,
  name: 'sandbox-widget',
  version: '0.0.0',
  type: 'widget',
  label: 'Sandbox Widget',
  entry: 'index.js',
  size: {w: 4, h: 3},
  i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'}},
});

/** Vite hooks are typed as ObjectHook unions; call the function form directly in tests. */
function callHook<T>(hook: unknown, ...args: unknown[]): T {
  return (hook as (...a: unknown[]) => T)(...args);
}

describe('resolveSandboxPluginPath', () => {
  it('returns null when MNDW_SANDBOX_PLUGIN is unset', () => {
    expect(resolveSandboxPluginPath(undefined, repoRoot)).toBeNull();
    expect(resolveSandboxPluginPath('', repoRoot)).toBeNull();
  });

  it('resolves a relative path against the repo root', () => {
    expect(resolveSandboxPluginPath('plugins/examples/sample-page', repoRoot)).toBe(pluginDir);
  });

  it('passes an absolute path through unchanged', () => {
    expect(resolveSandboxPluginPath('/tmp/plugin', repoRoot)).toBe('/tmp/plugin');
  });
});

describe('isSandboxFile', () => {
  it('matches files inside the sandbox plugin directory', () => {
    expect(isSandboxFile(path.join(pluginDir, 'src', 'index.ts'), pluginDir)).toBe(true);
    expect(isSandboxFile(manifestPath, pluginDir)).toBe(true);
  });

  it('does not match files outside the sandbox plugin directory', () => {
    expect(isSandboxFile('/repo/frontend/host/src/main.ts', pluginDir)).toBe(false);
    expect(isSandboxFile(pluginDir + '-sibling/x.ts', pluginDir)).toBe(false);
  });
});

describe('sandboxPlugin', () => {
  it('still resolves the virtual ids but serves inert stubs when there is no sandbox path', () => {
    const plugin = sandboxPlugin(null);

    expect(callHook<string>(plugin.resolveId, 'virtual:sandbox-plugin')).toBe('\0virtual:sandbox-plugin');
    expect(callHook<string>(plugin.load, '\0virtual:sandbox-plugin')).toContain('createInstance = undefined');
    expect(callHook<string>(plugin.load, '\0virtual:sandbox-manifest')).toContain('export default null');
    expect(callHook<{server?: unknown}>(plugin.config, {}, {command: 'serve'})).toEqual({});
  });

  it('resolves only the sandbox virtual module ids', () => {
    const plugin = sandboxPlugin(pluginDir, fakeFs({[manifestPath]: validManifest}));

    expect(callHook<string>(plugin.resolveId, 'virtual:sandbox-plugin')).toBe('\0virtual:sandbox-plugin');
    expect(callHook<string>(plugin.resolveId, 'virtual:sandbox-manifest')).toBe(
      '\0virtual:sandbox-manifest',
    );
    expect(callHook<string | undefined>(plugin.resolveId, 'some-other-module')).toBeUndefined();
  });

  it('loads the virtual plugin and manifest sources', () => {
    const plugin = sandboxPlugin(pluginDir, fakeFs({[manifestPath]: validManifest}));

    expect(callHook<string>(plugin.load, '\0virtual:sandbox-plugin')).toContain('export {createInstance}');
    expect(callHook<string>(plugin.load, '\0virtual:sandbox-manifest')).toContain('"name":"sandbox-widget"');
    expect(callHook<string | undefined>(plugin.load, '/some/real/file.ts')).toBeUndefined();
  });

  it('fails loudly when the manifest is missing rather than registering a fake plugin', () => {
    const plugin = sandboxPlugin(pluginDir, fakeFs({}));

    expect(() => callHook(plugin.load, '\0virtual:sandbox-manifest')).toThrow(/manifest\.json/);
  });

  it('exposes the sandbox plugin dir through the Vite fs allow-list', () => {
    const plugin = sandboxPlugin(pluginDir, fakeFs({[manifestPath]: validManifest}));
    const config = callHook<{server?: {fs?: {allow?: string[]}}}>(plugin.config, {}, {command: 'serve'});

    expect(config.server?.fs?.allow).toContain(pluginDir);
  });

  it('adds external sandbox source to Vite watcher', () => {
    const plugin = sandboxPlugin(pluginDir, fakeFs({[manifestPath]: validManifest}));
    const watcher = {add: vi.fn()};

    callHook(plugin.configureServer, {watcher});

    expect(watcher.add).toHaveBeenCalledWith(pluginDir);
  });

  it('invalidates both virtual modules on a sandbox source change and returns them', () => {
    const plugin = sandboxPlugin(pluginDir, fakeFs({[manifestPath]: validManifest}));
    const mods = {
      '\0virtual:sandbox-plugin': {id: '\0virtual:sandbox-plugin'},
      '\0virtual:sandbox-manifest': {id: '\0virtual:sandbox-manifest'},
    } as const;
    const invalidated: string[] = [];
    const server = {
      moduleGraph: {
        getModuleById: (id: string) => (mods as Record<string, unknown>)[id],
        invalidateModule: (mod: {id: string}) => invalidated.push(mod.id),
      },
    };

    const result = callHook<Array<{id: string}> | undefined>(plugin.handleHotUpdate, {
      file: path.join(pluginDir, 'src', 'index.ts'),
      server,
    });

    expect(invalidated).toEqual(['\0virtual:sandbox-plugin', '\0virtual:sandbox-manifest']);
    expect(result?.map((m) => m.id)).toEqual(['\0virtual:sandbox-plugin', '\0virtual:sandbox-manifest']);
  });

  it('ignores hot updates for files outside the sandbox dir', () => {
    const plugin = sandboxPlugin(pluginDir, fakeFs({[manifestPath]: validManifest}));
    const server = {moduleGraph: {getModuleById: vi.fn(), invalidateModule: vi.fn()}};

    const result = callHook<unknown>(plugin.handleHotUpdate, {
      file: '/repo/frontend/host/src/main.ts',
      server,
    });

    expect(result).toBeUndefined();
    expect(server.moduleGraph.invalidateModule).not.toHaveBeenCalled();
  });
});
