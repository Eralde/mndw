import {describe, expect, it, vi} from 'vitest';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {expectedStateReached, reconcile} from './reconcile.js';

const backend = {routes: {}};

function plugin(overrides: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    type: 'widget',
    name: 'network-tools',
    version: '1.0.0',
    label: 'Network Tools',
    entry: 'index.js',
    source: 'upload',
    approval: 'approved',
    enabled: true,
    size: {w: 4, h: 3},
    backend,
    ...overrides,
  } as PluginListEntry;
}

describe('plugin lifecycle reconciliation', () => {
  it('recognizes an ambiguous delete once the entry is absent', async () => {
    const listPlugins = vi.fn().mockResolvedValue([]);

    await expect(reconcile({kind: 'delete'}, 'network-tools', listPlugins, {polls: 1, intervalMs: 0}))
      .resolves.toBe('ok');
  });

  it('leaves a finishing notice when the expected state does not arrive in budget', async () => {
    const listPlugins = vi.fn().mockResolvedValue([plugin()]);

    await expect(reconcile({kind: 'disable'}, 'network-tools', listPlugins, {polls: 2, intervalMs: 0}))
      .resolves.toBe('notice-finishing');
    expect(listPlugins).toHaveBeenCalledTimes(2);
  });

  it('never treats a restart as reconciled', async () => {
    const listPlugins = vi.fn();

    await expect(reconcile({kind: 'restart'}, 'network-tools', listPlugins, {polls: 2, intervalMs: 0}))
      .resolves.toBe('outcome-unknown');
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it('matches permission state from operation payload', () => {
    const entry = plugin({
      permissions: ['persistent-rci-session:write'],
      permissionGrants: {'persistent-rci-session:write': true},
    });

    expect(expectedStateReached(
      {kind: 'permission', permission: 'persistent-rci-session:write', enabled: true},
      'network-tools',
      [entry],
    )).toBe(true);
    expect(expectedStateReached(
      {kind: 'permission', permission: 'persistent-rci-session:write', enabled: false},
      'network-tools',
      [entry],
    )).toBe(false);
  });

  it.each([
    [{kind: 'deny'} as const, [], true],
    [{kind: 'enable'} as const, [plugin({enabled: true})], true],
    [{kind: 'disable'} as const, [plugin({enabled: false})], true],
    [{kind: 'approve'} as const, [plugin({approval: 'approved'})], true],
    [{kind: 'restart'} as const, [plugin()], false],
  ])('evaluates %o against the refreshed list', (operation, list, expected) => {
    expect(expectedStateReached(operation, 'network-tools', list)).toBe(expected);
  });
});
