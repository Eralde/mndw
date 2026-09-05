import {describe, expect, it} from 'vitest';
import type {MwsPortRole} from '../api/mws-rci-write';
import type {NodeEditState} from './node-settings.store';

const initialState: NodeEditState = {
  staticIpEnabled: true,
  staticIp: '192.168.1.50',
  updateChannel: 'stable',
  portRoles: [{port: 0, role: 'primary'}],
};

describe('NodeSettingsStore', () => {
  it('keeps an independent named baseline and draft', async () => {
    const {NodeSettingsStore} = await import('./node-settings.store');
    const store = new NodeSettingsStore();

    store.initialize('My Extender', initialState, [{id: 'Bridge0', label: 'LAN'}]);
    store.setName('Edited');
    store.setPortRole(0, {segment: 'Bridge0'});

    expect(store.draft()?.name).toBe('Edited');
    expect(store.baseline()?.name).toBe('My Extender');
    expect(store.draft()?.portRoles[0]?.role).toEqual({segment: 'Bridge0'} satisfies MwsPortRole);
    expect(store.baseline()?.portRoles[0]?.role).toBe('primary');
    expect(store.hasChanges()).toBe(true);
  });

  it('resets draft to baseline while preserving loaded segments', async () => {
    const {NodeSettingsStore} = await import('./node-settings.store');
    const store = new NodeSettingsStore();

    store.initialize('My Extender', initialState, [{id: 'Bridge0', label: 'LAN'}]);
    store.setName('Edited');
    store.resetDraft();

    expect(store.draft()).toEqual(store.baseline());
    expect(store.segments()).toEqual([{id: 'Bridge0', label: 'LAN'}]);
    expect(store.hasChanges()).toBe(false);
  });

  it('tracks field save state independently and commits only successful fields', async () => {
    const {NodeSettingsStore} = await import('./node-settings.store');
    const store = new NodeSettingsStore();

    store.initialize('My Extender', initialState, []);
    store.setName('Saved');
    store.setUpdateChannel('preview');
    store.markSaving('name');
    store.commit('name');
    store.fail('update-channel', 'Rejected');

    expect(store.baseline()?.name).toBe('Saved');
    expect(store.baseline()?.updateChannel).toBe('stable');
    expect(store.draft()?.updateChannel).toBe('preview');
    expect(store.fieldState('name')).toEqual({saving: false, error: null, success: true});
    expect(store.fieldState('update-channel')).toEqual({saving: false, error: 'Rejected', success: false});
  });

  it('commits a role that was previously using the native primary default', async () => {
    const {NodeSettingsStore} = await import('./node-settings.store');
    const store = new NodeSettingsStore();

    store.initialize('My Extender', {...initialState, portRoles: []}, []);
    store.setPortRole(1, {segment: 'Guest'});
    store.commit('port-1');

    expect(store.baseline()?.portRoles).toEqual([{port: 1, role: {segment: 'Guest'}}]);
    expect(store.hasChanges()).toBe(false);
  });

  it('reconciles only fields confirmed by a reread', async () => {
    const {NodeSettingsStore} = await import('./node-settings.store');
    const store = new NodeSettingsStore();

    store.initialize('My Extender', initialState, []);
    store.setName('Requested');
    store.setUpdateChannel('preview');
    store.fail('name', 'Save failed');
    store.fail('update-channel', 'Save failed');
    store.beginReconciliation(['name', 'update-channel']);
    store.reconcile('Requested', {...initialState, updateChannel: 'stable'}, []);

    expect(store.baseline()?.name).toBe('Requested');
    expect(store.baseline()?.updateChannel).toBe('stable');
    expect(store.draft()?.name).toBe('Requested');
    expect(store.draft()?.updateChannel).toBe('preview');
    expect(store.reconciliation()).toBe('error');
    expect(store.fieldState('name')).toEqual({saving: false, error: null, success: true});
    expect(store.fieldState('update-channel')).toEqual({saving: false, error: 'Save failed', success: false});
  });
});
