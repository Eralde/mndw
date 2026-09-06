import {z} from 'zod';

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const nonEmptyString = z.string().min(1);
const integer = z.number().int();
const nonNegativeInteger = integer.nonnegative();

export const MaxEventPayloadBytes = 4 * 1024;

export const eventSourceSchema = z.enum(['hook', 'log', 'internal']);

export const eventPermissionSchema = z.string().regex(
  /^events:(\*|[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)*)$/,
);

const eventBranch = <TTopic extends string, TPayload extends z.ZodTypeAny>(
  topic: TTopic,
  source: z.ZodTypeAny | z.infer<typeof eventSourceSchema>,
  payload: TPayload,
) => {
  const sourceSchema = typeof source === 'string' ? z.literal(source) : source;

  return z.object({
    id: ulidSchema,
    ts: integer,
    topic: z.literal(topic),
    source: sourceSchema,
    payload,
  }).strict();
};

const stringPayload = (shape: Record<string, z.ZodTypeAny>) => {
  return z.object(shape).strict();
};

export const eventSchema = z.union([
  eventBranch(
    'wan.connected',
    z.union([z.literal('hook'), z.literal('log')]),
    stringPayload({
      interface: nonEmptyString,
      address: nonEmptyString,
      mask: nonEmptyString,
      gateway: nonEmptyString,
    }),
  ),
  eventBranch(
    'wan.disconnected',
    z.union([z.literal('hook'), z.literal('log')]),
    stringPayload({interface: nonEmptyString}),
  ),
  eventBranch(
    'net.ip_changed',
    z.union([z.literal('hook'), z.literal('log')]),
    z.object({
      address: nonEmptyString,
      mask: nonEmptyString,
      link: nonEmptyString,
      connected: z.boolean(),
    }).strict(),
  ),
  eventBranch(
    'net.dhcp_lease',
    'log',
    stringPayload({
      mac: nonEmptyString,
      ip: nonEmptyString,
      hostname: nonEmptyString,
      action: nonEmptyString,
    }),
  ),
  eventBranch('net.dns_changed', 'log', z.object({resolvers: z.array(nonEmptyString)}).strict()),
  eventBranch(
    'wifi.client_join',
    'log',
    stringPayload({
      mac: nonEmptyString,
      band: nonEmptyString,
      ssid: nonEmptyString,
      iface: nonEmptyString,
    }),
  ),
  eventBranch(
    'wifi.client_leave',
    'log',
    stringPayload({
      mac: nonEmptyString,
      band: nonEmptyString,
      ssid: nonEmptyString,
      iface: nonEmptyString,
    }),
  ),
  eventBranch(
    'firewall.rebuilt',
    'hook',
    stringPayload({
      table_type: nonEmptyString,
      table: nonEmptyString,
    }),
  ),
  eventBranch(
    'usb.attached',
    'hook',
    stringPayload({
      device: nonEmptyString,
      model: nonEmptyString,
      vendor: nonEmptyString,
      port: nonEmptyString,
    }),
  ),
  eventBranch(
    'usb.detached',
    'hook',
    stringPayload({
      device: nonEmptyString,
      port: nonEmptyString,
    }),
  ),
  eventBranch(
    'fs.mounted',
    'hook',
    stringPayload({
      fs_type: nonEmptyString,
      label: nonEmptyString,
      directory: nonEmptyString,
    }),
  ),
  eventBranch(
    'fs.unmounted',
    'hook',
    stringPayload({
      label: nonEmptyString,
      directory: nonEmptyString,
    }),
  ),
  eventBranch('clock.synced', 'hook', z.object({offset_ms: integer.optional()}).strict()),
  eventBranch(
    'schedule.fired',
    'hook',
    z.object({
      name: nonEmptyString,
      action: nonEmptyString,
      elapsed: nonNegativeInteger,
    }).strict(),
  ),
  eventBranch(
    'button.pressed',
    'hook',
    stringPayload({
      button: nonEmptyString,
      gesture: nonEmptyString,
    }),
  ),
  eventBranch(
    'auth.login',
    'log',
    z.object({
      user: nonEmptyString,
      ip: nonEmptyString,
      success: z.boolean(),
    }).strict(),
  ),
  eventBranch('firmware.available', 'log', stringPayload({version: nonEmptyString})),
  eventBranch(
    'plugin.installed',
    'internal',
    stringPayload({
      name: nonEmptyString,
      version: nonEmptyString,
    }),
  ),
  eventBranch('plugin.removed', 'internal', stringPayload({name: nonEmptyString})),
  eventBranch(
    'plugin.approved',
    'internal',
    stringPayload({
      name: nonEmptyString,
      version: nonEmptyString,
    }),
  ),
  eventBranch('plugin.started', 'internal', stringPayload({name: nonEmptyString})),
  eventBranch(
    'plugin.stopped',
    'internal',
    z.object({
      name: nonEmptyString,
      reason: nonEmptyString,
    }).strict(),
  ),
  eventBranch(
    'daemon.started',
    'internal',
    z.object({
      version: nonEmptyString,
      uptime_ms: nonNegativeInteger,
    }).strict(),
  ),
  eventBranch('daemon.stopping', 'internal', stringPayload({reason: nonEmptyString})),
  eventBranch('daemon.updated', 'internal', stringPayload({version: nonEmptyString})),
  eventBranch(
    'storage.low',
    'internal',
    z.object({
      path: z.literal('/opt'),
      available_bytes: nonNegativeInteger,
      threshold_bytes: nonNegativeInteger,
    }).strict(),
  ),
]).superRefine((event, context) => {
  const encoded = new TextEncoder().encode(JSON.stringify(event.payload));

  if (encoded.length > MaxEventPayloadBytes) {
    context.addIssue({code: 'custom', message: `payload exceeds ${MaxEventPayloadBytes} bytes`});
  }
});

export type MndwEvent = z.infer<typeof eventSchema>;
export type EventSource = z.infer<typeof eventSourceSchema>;
export type EventTopic = MndwEvent['topic'];
export type Unsubscribe = () => void;

export interface PluginEventFacade {
  subscribe(topics: string | readonly string[], handler: (event: MndwEvent) => void): Unsubscribe;
  onResync(handler: () => void): Unsubscribe;
}

export function createEventSchemaDocument(): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(eventSchema, {unrepresentable: 'any'});

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://mndw/unified-event.schema.json',
    title: 'mndw unified event',
    description: 'Generated from frontend/sdk/src/event-schema.ts — do not edit by hand.',
    ...jsonSchema,
  };
}
