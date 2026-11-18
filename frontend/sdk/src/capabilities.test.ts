import {describe, expect, it} from 'vitest';
import {EVENT_CAPABILITY_PATTERN} from './event-schema.js';
import {
  PERSISTENT_RCI_CAPABILITIES,
  isPersistentRciCapability,
  persistentRciCapabilitySchema,
  pluginCapabilitySchema,
} from './capabilities.js';

describe('capability authority', () => {
  it('lists the persistent RCI capabilities in grant order', () => {
    expect(PERSISTENT_RCI_CAPABILITIES).toEqual(['persistent-rci-session:read', 'persistent-rci-session:write']);
    expect(persistentRciCapabilitySchema.options).toEqual([...PERSISTENT_RCI_CAPABILITIES]);
  });

  it('narrows only persistent RCI capabilities', () => {
    expect(isPersistentRciCapability('persistent-rci-session:write')).toBe(true);
    expect(isPersistentRciCapability('events:wan')).toBe(false);
    expect(isPersistentRciCapability('persistent-rci-session:admin')).toBe(false);
  });

  it('accepts persistent RCI and event capabilities and nothing else', () => {
    expect(pluginCapabilitySchema.parse('persistent-rci-session:read')).toBe('persistent-rci-session:read');
    expect(pluginCapabilitySchema.parse('events:wan,wifi')).toBe('events:wan,wifi');
    expect(pluginCapabilitySchema.safeParse('events:WAN').success).toBe(false);
    // Parity case with the Go validator: without the `m` flag JS `$` matches only at end of input
    // (unlike PCRE/Python), so a trailing line terminator is rejected here and by Go RE2 alike.
    expect(pluginCapabilitySchema.safeParse('events:wan\n').success).toBe(false);
    expect(pluginCapabilitySchema.safeParse('events:wan\r\n').success).toBe(false);
    expect(pluginCapabilitySchema.safeParse('rci:read').success).toBe(false);
  });

  it('exposes the event capability pattern as an anchored, flag-free source Go can reuse', () => {
    expect(EVENT_CAPABILITY_PATTERN.flags).toBe('');
    expect(EVENT_CAPABILITY_PATTERN.source).toBe('^events:(\\*|[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)*)$');
  });
});
