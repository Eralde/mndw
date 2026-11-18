import {type PluginManifestOutput, pluginManifestSchema} from './manifest-schema.js';
import type {ZodIssue} from 'zod';

export class ManifestValidationError extends Error {
  public readonly issues: readonly {path: string; message: string}[];

  constructor(pluginName: string, issues: readonly ZodIssue[]) {
    const formattedIssues = issues.map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');

      return {path, message: issue.message};
    });
    const reason = formattedIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');

    super(`Invalid manifest for "${pluginName}": ${reason}`);
    this.issues = formattedIssues;
  }
}

export function validateManifest(data: unknown): PluginManifestOutput {
  if (
    typeof data === 'object'
    && data !== null
    && !Array.isArray(data)
    && Object.prototype.hasOwnProperty.call(data, 'permissions')
  ) {
    const record = data as Record<string, unknown>;
    const pluginName = typeof record.name === 'string' ? record.name : 'unknown';

    throw new ManifestValidationError(pluginName, [{
      code: 'custom',
      path: ['permissions'],
      message: 'permissions was renamed to capabilities in 0.3',
    }]);
  }

  const result = pluginManifestSchema.safeParse(data);

  if (!result.success) {
    const pluginName = typeof data === 'object' && data !== null
      ? typeof (data as Record<string, unknown>).name === 'string'
        ? (data as Record<string, unknown>).name as string
        : 'unknown'
      : 'unknown';

    throw new ManifestValidationError(pluginName, result.error.issues);
  }

  return result.data;
}
