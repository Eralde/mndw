import {z} from 'zod';
import {eventPermissionSchema} from './event-schema.js';

/**
 * Grantable persistent RCI permissions, in grant order. Single authority for the
 * SDK, the host, and the generated Go constants
 * (`daemon/contracts-go/manifest/permissions_generated.go`).
 */
export const PERSISTENT_RCI_PERMISSIONS = ['persistent-rci-session:read', 'persistent-rci-session:write'] as const;

export type PersistentRciPermission = (typeof PERSISTENT_RCI_PERMISSIONS)[number];

export const persistentRciPermissionSchema = z.enum(PERSISTENT_RCI_PERMISSIONS);

/** Every permission a manifest may declare: a grantable RCI permission or an `events:` declaration. */
export const pluginPermissionSchema = z.union([persistentRciPermissionSchema, eventPermissionSchema]);

export const isPersistentRciPermission = (value: string): value is PersistentRciPermission => {
  return (PERSISTENT_RCI_PERMISSIONS as readonly string[]).includes(value);
};
