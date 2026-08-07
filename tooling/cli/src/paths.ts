import {resolve} from 'node:path';

export function resolvePluginDir(pluginDir: string): string {
  return resolve(process.cwd(), pluginDir);
}
