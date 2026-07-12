import {z} from 'zod';

// Plugin `name` is used as a filesystem path segment (staging dir, module URL, `/api/plugins/<name>`).
// Constrain it so it can't traverse directories or inject shell metacharacters.
const pluginNameSchema = z.string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    {
      message: 'name must be lowercase alphanumeric with hyphens (e.g. my-widget)',
    },
  );

// Any path a plugin declares (entry module, script source, daemon hooks) is interpolated into a
// filesystem/URL path. Allow relative subpaths (e.g. `dist/index.js`) but reject absolute paths and
// traversal. Endpoint/websocket paths are relative too — v1's `/api/plugins/` / `/ws/plugins/`
// prefix requirement is gone (the daemon composes the full URL and namespaces it by plugin name).
const safeRelativePath = (value: string): boolean => {
  return !value.startsWith('/') && !value.includes('..') && !value.includes('\\');
};

const hasFileName = (value: string): boolean => {
  const parts = value.split('/').filter(Boolean);

  return Boolean(parts[parts.length - 1]);
};

const safeRelativePathSchema = z.string().min(1)
  .refine(safeRelativePath, {message: 'must be a safe relative path'});

const pluginEntrySchema = safeRelativePathSchema
  .refine(hasFileName, {message: 'entry must include a file name'});

// opkg package names: lowercase, may contain `+ _ . -` (matches Entware/opkg naming).
const pluginBackendOpkgSchema = z.string().regex(/^[a-z0-9][a-z0-9+_.-]*$/);

const pluginBackendScriptSchema = z.object({
  id: z.string().min(1),
  runtime: z.literal('sh'),
  source: z
    .string()
    .min(1)
    .refine(safeRelativePath, {message: 'source must be a safe relative path'}),
})
  .refine(
    (script) => hasFileName(script.source),
    {message: 'source must include a file name', path: ['source']},
  );

const pluginBackendEndpointSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1)
    .refine(safeRelativePath, {message: 'path must be a safe relative path'}),
  method: z.string()
    .transform((m) => m.toUpperCase())
    .pipe(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])),
  scriptId: z.string().min(1),
});

const pluginBackendWebSocketSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1)
    .refine(safeRelativePath, {message: 'path must be a safe relative path'}),
  target: z.string().min(1),
  protocols: z.array(z.string().min(1)).optional(),
});

const pluginBackendDaemonSchema = z.object({
  start: safeRelativePathSchema.refine(hasFileName, {message: 'start must include a file name'}),
  stop: safeRelativePathSchema.refine(hasFileName, {message: 'stop must include a file name'}),
});

const pluginBackendSchema = z.object({
  opkg: z.array(pluginBackendOpkgSchema).optional(),
  scripts: z.array(pluginBackendScriptSchema).optional(),
  endpoints: z.array(pluginBackendEndpointSchema).optional(),
  websockets: z.array(pluginBackendWebSocketSchema).optional(),
  daemon: pluginBackendDaemonSchema.optional(),
  public: z.boolean().optional(),
}).optional()
  .superRefine((backend, ctx) => {
    if (!backend) {
      return;
    }

    const scriptIds = backend.scripts?.map((s) => s.id) ?? [];
    const basenames = backend.scripts?.map((s) =>
      s.source.split('/').filter(Boolean)
        .pop() ?? ''
    )
      .filter(Boolean) ?? [];
    const endpointIds = backend.endpoints?.map((endpoint) => endpoint.id) ?? [];
    const wsIds = backend.websockets?.map((w) => w.id) ?? [];

    if (new Set(scriptIds).size !== scriptIds.length) {
      ctx.addIssue({code: 'custom', message: 'backend.scripts contains duplicate id'});
    }

    if (new Set(basenames).size !== basenames.length) {
      ctx.addIssue({code: 'custom', message: 'backend.scripts contains duplicate source basename'});
    }

    if (new Set(endpointIds).size !== endpointIds.length) {
      ctx.addIssue({code: 'custom', message: 'backend.endpoints contains duplicate id'});
    }

    if (new Set(wsIds).size !== wsIds.length) {
      ctx.addIssue({code: 'custom', message: 'backend.websockets contains duplicate id'});
    }

    const scriptIdSet = new Set(scriptIds);

    for (const endpoint of backend.endpoints ?? []) {
      if (!scriptIdSet.has(endpoint.scriptId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'backend.endpoints[].scriptId must reference a declared script',
          path: ['endpoints'],
        });
      }
    }
  });

// Grid units on the 12-column dashboard. Columns cap at the grid width; rows are unbounded (tiles
// scroll vertically).
const gridColumns = z.number()
  .int()
  .positive()
  .max(12);
const gridRows = z.number()
  .int()
  .positive();

const manifestVersionField = z.literal(2)
  .describe('Manifest format version. Must be 2.');
const nameField = pluginNameSchema
  .describe(
    'Unique plugin id: lowercase alphanumeric with hyphens (e.g. my-widget). Used as the on-disk folder and URL segment.',
  );
const versionField = z.string().min(1)
  .describe('Semver-ish version string (e.g. 2.0.0).');
const labelField = z.string().min(1)
  .describe('Human-readable name shown in the dashboard / navigation.');
const entryField = pluginEntrySchema
  .describe('Relative path to the bundled entry module, served from /plugins/<name>/<entry> (e.g. index.js).');
const iconField = z.string().optional()
  .describe('Optional icon name shown next to the plugin in the UI.');

const widgetSizeSchema = z.object({
  w: gridColumns.describe('Initial widget width in grid columns (1-12).'),
  h: gridRows.describe('Initial widget height in grid rows.'),
  minW: gridColumns.optional().describe('Minimum widget width in grid columns; must be <= w.'),
  minH: gridRows.optional().describe('Minimum widget height in grid rows; must be <= h.'),
})
  .refine(
    (size) => size.minW === undefined || size.minW <= size.w,
    {message: 'size.minW must be less than or equal to size.w', path: ['minW']},
  )
  .refine(
    (size) => size.minH === undefined || size.minH <= size.h,
    {message: 'size.minH must be less than or equal to size.h', path: ['minH']},
  )
  .describe('Widget size in grid units on the 12-column dashboard grid.');

const widgetManifestSchema = z.object({
  manifestVersion: manifestVersionField,
  name: nameField,
  version: versionField,
  type: z.literal('widget'),
  label: labelField,
  entry: entryField,
  icon: iconField,
  size: widgetSizeSchema,
  backend: pluginBackendSchema,
});

const pageManifestSchema = z.object({
  manifestVersion: manifestVersionField,
  name: nameField,
  version: versionField,
  type: z.literal('page'),
  label: labelField,
  entry: entryField,
  icon: iconField,
  route: z.string().regex(/^\/[^/?#*]+$/)
    .refine(
      (r) => !['/', '/login', '/settings'].includes(r),
      {message: 'route is reserved by the host'},
    )
    .describe('Single-segment route the page mounts on (e.g. /demo). /, /login, /settings are reserved.'),
  backend: pluginBackendSchema,
});

export const pluginManifestSchema = z.discriminatedUnion('type', [
  widgetManifestSchema,
  pageManifestSchema,
]);

export type PluginManifestInput = z.input<typeof pluginManifestSchema>;
export type PluginManifestOutput = z.infer<typeof pluginManifestSchema>;
