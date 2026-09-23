import {
  type BackendRouteDescriptor,
  type PluginManifestI18n,
  type WidgetSize,
  isPersistentRciPermission,
  pluginPermissionSchema,
} from '@mndw/sdk';
import {z} from 'zod';

const sourceSchema = z.enum(['builtin', 'registry', 'upload']);
const approvalSchema = z.enum(['pending', 'approved']);
const depsStatusSchema = z.enum(['ready', 'installing', 'failed']);
const runtimeStateSchema = z.enum(['stopped', 'capacity_blocked', 'starting', 'ready', 'backoff', 'failed']);
const grantPermissionSchema = z.record(z.string(), z.boolean()).superRefine((grants, ctx) => {
  for (const permission of Object.keys(grants)) {
    if (!isPersistentRciPermission(permission)) {
      ctx.addIssue({code: 'custom', path: [permission], message: 'only persistent RCI permissions may be granted'});
    }
  }
});

const routeDescriptorSchema: z.ZodType<BackendRouteDescriptor> = z.object({
  transport: z.enum(['http', 'websocket']),
  path: z.string(),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  protocols: z.array(z.string()).optional(),
});

/** Daemon wire-shape backend descriptor: route map only; SDK adds approval/enabled separately. */
const backendDescriptorSchema = z.object({
  routes: z.record(z.string(), routeDescriptorSchema),
});

const sizeSchema: z.ZodType<WidgetSize> = z.object({
  w: z.number(),
  h: z.number(),
  minW: z.number().optional(),
  minH: z.number().optional(),
});

const i18nSchema: z.ZodType<PluginManifestI18n> = z.object({
  defaultLocale: z.string(),
  locales: z.record(z.string(), z.string()),
});

const runtimeStatusSchema = z.object({
  state: runtimeStateSchema,
  restartCount: z.number(),
  consecutiveFailures: z.number(),
  startedAt: z.string().optional(),
  nextAttemptAt: z.string().optional(),
  lastExit: z.string().optional(),
  lastError: z.string().optional(),
  recentStderr: z.array(z.string()).optional(),
  requiredProtocol: z.number().optional(),
  compatible: z.boolean().optional(),
  supportedProtocols: z.array(z.number()).optional(),
});

const baseFields = {
  name: z.string(),
  version: z.string(),
  label: z.string(),
  entry: z.string(),
  icon: z.string().optional(),
  source: sourceSchema,
  approval: approvalSchema,
  enabled: z.boolean(),
  permissions: z.array(pluginPermissionSchema).optional(),
  permissionGrants: grantPermissionSchema.optional(),
  depsStatus: depsStatusSchema,
  backend: backendDescriptorSchema,
  i18n: i18nSchema.optional(),
  // Host-populated after decode; omitted by daemon wire responses but required by the loader.
  catalogBaseUrl: z.string().optional(),
  runtime: runtimeStatusSchema.optional(),
};

const widgetListEntrySchema = z.object({
  ...baseFields,
  type: z.literal('widget'),
  size: sizeSchema,
  fixedHeight: z.boolean().optional(),
});

const pageListEntrySchema = z.object({
  ...baseFields,
  type: z.literal('page'),
  route: z.string(),
});

export const pluginListEntrySchema = z.discriminatedUnion('type', [widgetListEntrySchema, pageListEntrySchema]);

export const mgmtListSchema = z.object({plugins: z.array(pluginListEntrySchema)});

export type DepsStatus = z.infer<typeof depsStatusSchema>;
/** Daemon wire-shape descriptor; the SDK `BackendDescriptor` is host-assembled input. */
export type PluginBackendDescriptor = z.infer<typeof backendDescriptorSchema>;
export type WidgetListEntry = z.infer<typeof widgetListEntrySchema>;
export type PageListEntry = z.infer<typeof pageListEntrySchema>;
export type PluginListEntry = z.infer<typeof pluginListEntrySchema>;

/** Wire enums pinned against `contracts/mgmt/fixtures/enums.json`. */
export const mgmtWireEnumSchemas = {
  source: sourceSchema,
  approval: approvalSchema,
  depsStatus: depsStatusSchema,
  runtimeState: runtimeStateSchema,
} as const;

/** The single runtime decoder for the `GET /api/mgmt/list` wire payload. */
export const decodeMgmtList = (json: unknown): PluginListEntry[] => mgmtListSchema.parse(json).plugins;

/** The single runtime decoder for list-shaped management mutation responses. */
export const decodeMgmtListEntry = (json: unknown): PluginListEntry => pluginListEntrySchema.parse(json);
