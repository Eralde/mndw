import {describe, expect, it} from 'vitest';
import {EVENT_PERMISSION_PATTERN} from './event-schema.js';
import {
  PERSISTENT_RCI_PERMISSIONS,
  isPersistentRciPermission,
  persistentRciPermissionSchema,
  pluginPermissionSchema,
} from './permissions.js';

describe('permission authority', () => {
  it('lists the persistent RCI permissions in grant order', () => {
    expect(PERSISTENT_RCI_PERMISSIONS).toEqual(['persistent-rci-session:read', 'persistent-rci-session:write']);
    expect(persistentRciPermissionSchema.options).toEqual([...PERSISTENT_RCI_PERMISSIONS]);
  });

  it('narrows only persistent RCI permissions', () => {
    expect(isPersistentRciPermission('persistent-rci-session:write')).toBe(true);
    expect(isPersistentRciPermission('events:wan')).toBe(false);
    expect(isPersistentRciPermission('persistent-rci-session:admin')).toBe(false);
  });

  it('accepts persistent RCI and event permissions and nothing else', () => {
    expect(pluginPermissionSchema.parse('persistent-rci-session:read')).toBe('persistent-rci-session:read');
    expect(pluginPermissionSchema.parse('events:wan,wifi')).toBe('events:wan,wifi');
    expect(pluginPermissionSchema.safeParse('events:WAN').success).toBe(false);
    // Parity case with the Go validator: without the `m` flag JS `$` matches only at end of input
    // (unlike PCRE/Python), so a trailing line terminator is rejected here and by Go RE2 alike.
    expect(pluginPermissionSchema.safeParse('events:wan\n').success).toBe(false);
    expect(pluginPermissionSchema.safeParse('events:wan\r\n').success).toBe(false);
    expect(pluginPermissionSchema.safeParse('rci:read').success).toBe(false);
  });

  it('exposes the event permission pattern as an anchored, flag-free source Go can reuse', () => {
    expect(EVENT_PERMISSION_PATTERN.flags).toBe('');
    expect(EVENT_PERMISSION_PATTERN.source).toBe('^events:(\\*|[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)*)$');
  });
});
