import {z} from 'zod';
import {eventCapabilitySchema} from './event-schema.js';

/**
 * Grantable persistent RCI capabilities, in grant order. Single authority for the
 * SDK, the host, and the generated Go constants
 * (`daemon/contracts-go/manifest/capabilities_generated.go`).
 */
export const PERSISTENT_RCI_CAPABILITIES = ['persistent-rci-session:read', 'persistent-rci-session:write'] as const;

export type PersistentRciCapability = (typeof PERSISTENT_RCI_CAPABILITIES)[number];

export const persistentRciCapabilitySchema = z.enum(PERSISTENT_RCI_CAPABILITIES);

/** Every capability a manifest may declare: a grantable RCI capability or an `events:` declaration. */
export const pluginCapabilitySchema = z.union([persistentRciCapabilitySchema, eventCapabilitySchema]);

export const isPersistentRciCapability = (value: string): value is PersistentRciCapability => {
  return (PERSISTENT_RCI_CAPABILITIES as readonly string[]).includes(value);
};
