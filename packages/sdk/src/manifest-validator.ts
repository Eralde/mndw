import {type PluginManifestOutput, pluginManifestSchema} from './manifest-schema.js';

export class ManifestValidationError extends Error {
  constructor(pluginName: string, reason: string) {
    super(`Invalid manifest for "${pluginName}": ${reason}`);
  }
}

export function validateManifest(data: unknown): PluginManifestOutput {
  const result = pluginManifestSchema.safeParse(data);

  if (!result.success) {
    const firstError = result.error.issues[0];
    const pluginName = typeof data === 'object' && data !== null
      ? typeof (data as Record<string, unknown>).name === 'string'
        ? (data as Record<string, unknown>).name as string
        : 'unknown'
      : 'unknown';

    throw new ManifestValidationError(pluginName, firstError.message);
  }

  return result.data;
}
