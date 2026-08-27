// Runtime authority for the plugin manifest shape (Zod). Generation flow:
//   this file  ->  contracts/manifest/manifest.schema.json  (generated contract)
//               ->  frontend/sdk/manifest.schema.json        (editor-hint copy)
// Neither JSON file is a source of truth; regenerate with `pnpm generate-contracts`.
// manifest.ts derives its TypeScript types from this schema via z.infer — do not
// re-declare the manifest shape by hand anywhere.

import {z} from 'zod';
import {isReservedPageRoute} from './page-routes.js';

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
  routes: z.array(execRouteSchema).min(1),
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
  routes: z.array(z.union([httpRouteSchema, websocketRouteSchema])).min(1),
}).strict()
  .superRefine((backend, ctx) => {
    validateRoutes(backend.routes, ctx);
  });

const backendSchema = z.union([execBackendSchema, serviceBackendSchema]);

const gridColumns = z.number().int()
  .positive()
  .max(12);
const gridRows = z.number().int()
  .positive();
const versionSchema = z.literal(1).describe('Manifest format version. Must be 1.');
const nameSchema = pluginNameSchema.describe('Unique plugin id used as the on-disk folder and URL segment.');
const versionField = z.string().min(1)
  .describe('Semver-ish version string.');
const labelField = z.string().min(1)
  .describe('Human-readable name shown in the dashboard or navigation.');
const entryField = pluginEntrySchema.describe('Relative path to the bundled entry module.');
const iconField = z.string().optional()
  .describe('Optional icon name.');
const permissionSchema = z.enum(['persistent-rci-session:read', 'persistent-rci-session:write']);
const permissionsSchema = z.array(permissionSchema).superRefine((permissions, ctx) => {
  if (new Set(permissions).size !== permissions.length) {
    ctx.addIssue({code: 'custom', message: 'permissions contains duplicate permission'});
  }
});

const sizeSchema = z.object({
  w: gridColumns,
  h: gridRows,
  minW: gridColumns.optional(),
  minH: gridRows.optional(),
}).refine((size) => size.minW === undefined || size.minW <= size.w, {
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
  manifestVersion: versionSchema,
  name: nameSchema,
  version: versionField,
  label: labelField,
  entry: entryField,
  icon: iconField,
  permissions: permissionsSchema.optional(),
  i18n: i18nSchema.optional(),
  backend: backendSchema.optional(),
};

const widgetManifestSchema = z.object({
  ...baseFields,
  type: z.literal('widget'),
  size: sizeSchema,
  fixedHeight: z.boolean().optional(),
});

const pageManifestSchema = z.object({
  ...baseFields,
  type: z.literal('page'),
  route: pageRouteSchema,
});

export const pluginManifestSchema = z.discriminatedUnion('type', [widgetManifestSchema, pageManifestSchema]);

export type PluginBackendAccessOutput = z.infer<typeof accessSchema>;
export type PluginBackendMethodOutput = z.infer<typeof methodSchema>;
export type PluginPermissionOutput = z.infer<typeof permissionSchema>;
export type PluginHttpRouteOutput = z.infer<typeof httpRouteSchema>;
export type PluginWebSocketRouteOutput = z.infer<typeof websocketRouteSchema>;
export type PluginExecRouteOutput = z.infer<typeof execRouteSchema>;
export type PluginExecBackendOutput = z.infer<typeof execBackendSchema>;
export type PluginServiceBackendOutput = z.infer<typeof serviceBackendSchema>;
export type PluginBackendOutput = z.infer<typeof backendSchema>;
export type WidgetSizeOutput = z.infer<typeof sizeSchema>;
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;
export type PluginManifestOutput = z.infer<typeof pluginManifestSchema>;
