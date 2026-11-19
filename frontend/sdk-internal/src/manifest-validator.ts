import {type PluginManifestOutput, pluginManifestSchema} from './manifest-schema.js';
import type {ZodIssue} from 'zod';

const REMOVED_MANIFEST_KEYS: Readonly<Record<string, string>> = {
  permissions: 'permissions was renamed to capabilities in 0.3',
  icon: 'icon was removed in 0.3',
  fixedHeight: 'fixedHeight was removed in 0.3',
};

export class ManifestValidationError extends Error {
  public readonly issues: readonly {path: string; message: string}[];

  constructor(pluginName: string, issues: readonly ZodIssue[]) {
    const formattedIssues = issues.map((issue) => {
      const issuePath = issue.code === 'unrecognized_keys'
        ? [...issue.path, [...issue.keys].sort()[0] ?? '<unknown>']
        : issue.path;
      const path = issuePath.length === 0 ? '<root>' : issuePath.join('.');

      return {path, message: issue.message};
    });
    const reason = formattedIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');

    super(`Invalid manifest for "${pluginName}": ${reason}`);
    this.issues = formattedIssues;
  }
}

export function validateManifest(data: unknown): PluginManifestOutput {
  let manifestData = data;

  if (
    typeof data === 'object'
    && data !== null
    && !Array.isArray(data)
  ) {
    const record = data as Record<string, unknown>;
    const pluginName = typeof record.name === 'string' ? record.name : 'unknown';

    for (const [key, message] of Object.entries(REMOVED_MANIFEST_KEYS)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        throw new ManifestValidationError(pluginName, [{
          code: 'custom',
          path: [key],
          message,
        }]);
      }
    }

    const normalized = {...record};

    if (record.type === 'page' || record.type === 'widget') {
      delete normalized[record.type === 'page' ? 'size' : 'route'];
    }

    manifestData = normalized;
  }

  const result = pluginManifestSchema.safeParse(manifestData);

  if (!result.success) {
    const pluginName = typeof data === 'object' && data !== null
      ? typeof (data as Record<string, unknown>).name === 'string'
        ? (data as Record<string, unknown>).name as string
        : 'unknown'
      : 'unknown';

    throw new ManifestValidationError(pluginName, result.error.issues);
  }

  delete result.data.$schema;

  return result.data;
}
