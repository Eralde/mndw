// Runtime authority for the plugin manifest shape (Zod). Generation flow:
//   this file  ->  contracts/manifest/manifest.schema.json  (generated contract)
//               ->  frontend/sdk/manifest.schema.json        (editor-hint copy)
// Neither JSON file is a source of truth; regenerate with `pnpm generate-contracts`.
// manifest.ts derives its TypeScript types from this schema via z.infer — do not
// re-declare the manifest shape by hand anywhere.

import {z} from 'zod';
import type {$ZodErrorMap} from 'zod/v4/core';
import {isReservedPageRoute} from './page-routes.js';
import {pluginCapabilitySchema} from './sdk-source.js';

const strictObjectError = (scope: 'manifest' | 'size'): $ZodErrorMap => (issue) => {
  if (issue.code !== 'unrecognized_keys') {
    return undefined;
  }

  const key = [...issue.keys].sort()[0] ?? '<unknown>';

  return `${scope} contains unknown field "${key}"`;
};

const pluginNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
  message: 'name must be lowercase alphanumeric with hyphens (e.g. my-widget)',
});

const safeRelativePath = (value: string): boolean => {
  return !value.startsWith('/')
    && !value.includes('..')
    && !value.includes('\\')
    && !value.split('/').some((segment) => segment === '.' || segment === '..');
};

const hasFileName = (value: string): boolean => {
  const parts = value.split('/').filter(Boolean);

  return Boolean(parts[parts.length - 1]);
};

const safeRelativePathSchema = z.string().min(1)
  .refine(safeRelativePath, {message: 'must be a safe relative path'});
const pluginEntrySchema = safeRelativePathSchema
  .refine(hasFileName, {message: 'entry must include a file name'});

const canonicalLocale = (value: string): string | undefined => {
  try {
    if (typeof Intl.getCanonicalLocales === 'function') {
      return Intl.getCanonicalLocales(value)[0];
    }

    if (typeof Intl.Locale === 'function') {
      return new Intl.Locale(value).toString();
    }
  } catch {
    // Fall through to the unsupported-runtime result below.
  }

  return undefined;
};

const localeTagSchema = z.string().min(1)
  .superRefine((value, ctx) => {
    const canonical = canonicalLocale(value);

    if (canonical === undefined) {
      ctx.addIssue({code: 'custom', message: 'must be a valid BCP-47 locale tag'});
    } else if (canonical !== value) {
      ctx.addIssue({code: 'custom', message: `must use canonical BCP-47 spelling (${canonical})`});
    }
  });
const catalogPathSchema = safeRelativePathSchema
  .refine((value) => value.endsWith('.json'), {message: 'catalog path must end with .json'});
const i18nSchema = z.object({
  defaultLocale: localeTagSchema,
  locales: z.record(z.string(), catalogPathSchema),
}).strict()
  .superRefine((i18n, ctx) => {
    const localeKeys = Object.keys(i18n.locales);

    if (localeKeys.length === 0) {
      ctx.addIssue({code: 'custom', path: ['locales'], message: 'locales must contain at least one locale'});
    }

    const canonicalKeys = new Map<string, string>();

    for (const key of localeKeys) {
      const canonical = canonicalLocale(key);

      if (canonical === undefined) {
        ctx.addIssue({code: 'custom', path: ['locales', key], message: 'must be a valid BCP-47 locale tag'});

        continue;
      }

      if (canonical !== key) {
        ctx.addIssue({
          code: 'custom',
          path: ['locales', key],
          message: `must use canonical BCP-47 spelling (${canonical})`,
        });
      }

      const previousKey = canonicalKeys.get(canonical);

      if (previousKey !== undefined && previousKey !== key) {
        ctx.addIssue({
          code: 'custom',
          path: ['locales', key],
          message: `canonical locale collides with ${previousKey}`,
        });
      } else {
        canonicalKeys.set(canonical, key);
      }
    }

    const canonicalDefault = canonicalLocale(i18n.defaultLocale);

    if (canonicalDefault !== undefined && !canonicalKeys.has(canonicalDefault)) {
      ctx.addIssue({code: 'custom', path: ['defaultLocale'], message: 'defaultLocale must be present in locales'});
    }
  });

const packageSchema = z.string().regex(/^[a-z0-9][a-z0-9+_.-]*$/);
const accessSchema = z.enum(['session', 'public']).default('session');
const methodSchema = z.string()
  .transform((method) => method.toUpperCase())
  .pipe(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']));

// Decode one layer before checking route names. Reject encoded/double-encoded
// separators, dot segments, and the daemon-reserved namespace.
const safeBackendRoutePath = (value: string): boolean => {
  if (
    value.length === 0 || value.startsWith('/') || value.includes('\\') || value.includes('?') || value.includes('#')
  ) {
    return false;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }

  if (decoded !== value || decoded.includes('%') || decoded.startsWith('/') || decoded.includes('\\')) {
    return false;
  }

  const segments = decoded.split('/');

  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && segments[0] !== '_mndw';
};

const commandSchema = safeRelativePathSchema
  .regex(/^backend\//, {message: 'command must start with backend/'})
  .refine(hasFileName, {message: 'command must include a file name'})
  .refine((command) => {
    return !command.split('/').some((segment) => segment === '.' || segment === '..');
  }, {message: 'command must not contain dot segments'});

const literalArgumentSchema = z.string()
  .min(1)
  .refine((value) => {
    return [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;

      return codePoint > 0x1f && codePoint !== 0x7f;
    });
  }, {message: 'args must not contain control characters'});

const httpRouteSchema = z.object({
  id: z.string().min(1),
  transport: z.literal('http'),
  method: methodSchema,
  path: z.string().refine(safeBackendRoutePath, {message: 'path must be canonical and safe'}),
  access: accessSchema,
});

const websocketRouteSchema = z.object({
  id: z.string().min(1),
  transport: z.literal('websocket'),
  path: z.string().refine(safeBackendRoutePath, {message: 'path must be canonical and safe'}),
  access: accessSchema,
  protocols: z.array(z.string().min(1)).optional(),
});

const execRouteSchema = httpRouteSchema.extend({command: commandSchema});

const validateRoutes = <T extends {id: string; transport: string; path: string; method?: string; access?: string}>(
  routes: T[],
  ctx: z.RefinementCtx,
): void => {
  const ids = routes.map((route) => route.id);

  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({code: 'custom', message: 'backend.routes contains duplicate id'});
  }

  const tuples = routes.map((route) => {
    return route.transport === 'http'
      ? `${route.transport}:${route.method}:${route.path}`
      : `${route.transport}:${route.path}`;
  });

  if (new Set(tuples).size !== tuples.length) {
    ctx.addIssue({code: 'custom', message: 'backend.routes contains duplicate route tuple'});
  }

  for (const route of routes) {
    if (route.transport === 'http' && route.access === 'public' && !['GET', 'HEAD'].includes(route.method ?? '')) {
      ctx.addIssue({code: 'custom', message: 'public HTTP routes may only use GET or HEAD'});
    }
  }
};

const execBackendSchema = z.object({
  kind: z.literal('exec'),
  packages: z.array(packageSchema).optional(),
  routes: z.array(execRouteSchema).min(1, {message: 'backend.routes must contain at least one route'}),
}).strict()
  .superRefine((backend, ctx) => {
    validateRoutes(backend.routes, ctx);
  });

const serviceBackendSchema = z.object({
  kind: z.literal('service'),
  protocolVersion: z.number().int()
    .positive(),
  command: commandSchema,
  args: z.array(literalArgumentSchema).optional(),
  packages: z.array(packageSchema).optional(),
  routes: z.array(z.union([httpRouteSchema, websocketRouteSchema])).min(1, {
    message: 'backend.routes must contain at least one route',
  }),
}).strict()
  .superRefine((backend, ctx) => {
    validateRoutes(backend.routes, ctx);
  });

const backendSchema = z.union([execBackendSchema, serviceBackendSchema]);

const gridColumns = z.number()
  .int({message: 'gridColumns must be an integer'})
  .min(1, {message: 'gridColumns must be at least 1'})
  .max(12, {message: 'gridColumns must be at most 12'});
const gridRows = z.number().int()
  .positive();
const versionSchema = z.literal(1).describe('Manifest format version. Must be 1.');
const nameSchema = pluginNameSchema.describe('Unique plugin id used as the on-disk folder and URL segment.');
const versionField = z.string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    {
      message: 'version must be valid SemVer (for example, 1.2.3)',
    },
  )
  .describe('Semantic version of this plugin.');
const labelField = z.string().min(1)
  .describe('Human-readable name shown in the dashboard or navigation.');
const descriptionField = z.string()
  .refine((value) => {
    const codePointCount = Array.from(value).length;

    return codePointCount >= 1 && codePointCount <= 160;
  }, {
    message: 'Description must contain between 1 and 160 Unicode code points.',
  })
  .meta({minLength: 1, maxLength: 160})
  .describe('Optional plain-text description in the plugin default language.');
const entryField = pluginEntrySchema.describe('Relative path to the bundled entry module.');
const capabilitySchema = pluginCapabilitySchema;
const capabilitiesSchema = z.array(capabilitySchema).superRefine((capabilities, ctx) => {
  if (new Set(capabilities).size !== capabilities.length) {
    ctx.addIssue({code: 'custom', message: 'capabilities contains duplicate capability'});
  }
});

const sizeSchema = z.object({
  w: gridColumns,
  h: gridRows,
  minW: gridColumns.optional(),
  minH: gridRows.optional(),
}, {error: strictObjectError('size')}).strict()
  .refine((size) => size.minW === undefined || size.minW <= size.w, {
    message: 'size.minW must be less than or equal to size.w',
    path: ['minW'],
  })
  .refine((size) => size.minH === undefined || size.minH <= size.h, {
    message: 'size.minH must be less than or equal to size.h',
    path: ['minH'],
  });

const pageRouteSchema = z.string().regex(/^\/[^/?#*]+$/)
  .refine((route) => !isReservedPageRoute(route), {message: 'route is reserved by the host'});

const baseFields = {
  $schema: z.string({error: '$schema must be a string'})
    .optional()
    .describe('JSON Schema editor hint for this manifest.'),
  manifestVersion: versionSchema,
  name: nameSchema,
  version: versionField,
  label: labelField,
  description: descriptionField.optional(),
  entry: entryField,
  capabilities: capabilitiesSchema.optional(),
  i18n: i18nSchema.optional(),
  backend: backendSchema.optional(),
};

const widgetManifestSchema = z.object({
  ...baseFields,
  type: z.literal('widget'),
  size: sizeSchema,
}, {error: strictObjectError('manifest')}).strict();

const pageManifestSchema = z.object({
  ...baseFields,
  type: z.literal('page'),
  route: pageRouteSchema,
}, {error: strictObjectError('manifest')}).strict();

export const pluginManifestSchema = z.discriminatedUnion('type', [widgetManifestSchema, pageManifestSchema]);

export type PluginBackendAccessOutput = z.infer<typeof accessSchema>;
export type PluginBackendMethodOutput = z.infer<typeof methodSchema>;
export type PluginCapabilityOutput = z.infer<typeof capabilitySchema>;
export type PluginHttpRouteOutput = z.infer<typeof httpRouteSchema>;
export type PluginWebSocketRouteOutput = z.infer<typeof websocketRouteSchema>;
export type PluginExecRouteOutput = z.infer<typeof execRouteSchema>;
export type PluginExecBackendOutput = z.infer<typeof execBackendSchema>;
export type PluginServiceBackendOutput = z.infer<typeof serviceBackendSchema>;
export type PluginBackendOutput = z.infer<typeof backendSchema>;
export type WidgetSizeOutput = z.infer<typeof sizeSchema>;
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

type OmitEditorSchema<T> = T extends unknown ? Omit<T, '$schema'> : never;

export type PluginManifestOutput = OmitEditorSchema<z.infer<typeof pluginManifestSchema>>;
