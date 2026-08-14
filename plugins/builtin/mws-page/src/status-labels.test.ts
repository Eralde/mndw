import {describe, expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import type {MwsNode} from './domain/mws/mws.types';
import enCatalog from '../i18n/en.json';
import {type TranslatorFn, getNodeStatusLabels, getPowerDisabledHint} from './status-labels';

const i18n = createTestI18n(enCatalog);
const t: TranslatorFn = (key, values) => i18n.t(key, values);

function node(overrides: Partial<MwsNode> = {}): MwsNode {
  return {
    id: 'node-1',
    cid: 'cid-1',
    name: 'Node 1',
    model: 'Model',
    ip: null,
    mac: 'node-1',
    isController: false,
    isOnline: true,
    fw: null,
    fwAvailable: null,
    system: null,
    backhaul: null,
    parent: null,
    children: [],
    clients: [],
    dualBand: false,
    ...overrides,
  };
}

describe('getNodeStatusLabels', () => {
  it('maps online, telemetry, remote-control, and client states to product labels', () => {
    const labels = getNodeStatusLabels(
      node({
        isOnline: false,
        mwsdStatus: {state: 'stale', lastTelemetryAt: 1},
        persistentSession: false,
        clients: [{mac: 'client-1', name: 'Client', ip: null, uptime: null, lastSeen: null, wired: false}],
      }),
      t,
    );

    expect(labels).toEqual({
      online: 'Offline',
      telemetry: 'Telemetry: stale',
      remoteControl: 'Remote control: disconnected',
      clients: '1 client',
    });
  });

  it('covers every telemetry state and treats missing telemetry as unavailable', () => {
    const states = [
      [undefined, 'Telemetry: not available'],
      ['starting', 'Telemetry: starting'],
      ['live', 'Telemetry: live'],
      ['stale', 'Telemetry: stale'],
      ['offline', 'Telemetry: offline'],
      ['unavailable', 'Telemetry: not available'],
    ] as const;

    for (const [state, expected] of states) {
      expect(
        getNodeStatusLabels(node({mwsdStatus: state === undefined ? undefined : {state, lastTelemetryAt: null}}), t)
          .telemetry,
      )
        .toBe(expected);
    }
  });

  it('covers every remote-control state', () => {
    expect(getNodeStatusLabels(node({persistentSession: undefined}), t).remoteControl)
      .toBe('Remote control: not available');
    expect(getNodeStatusLabels(node({persistentSession: false}), t).remoteControl)
      .toBe('Remote control: disconnected');
    expect(getNodeStatusLabels(node({persistentSession: true}), t).remoteControl)
      .toBe('Remote control: connected');
  });

  it('uses controller-specific no-telemetry wording', () => {
    const labels = getNodeStatusLabels(node({isController: true}), t);

    expect(labels.telemetry).toBe('No telemetry');
    expect(labels.remoteControl).toBe('Remote control: not available');
  });
});

describe('getPowerDisabledHint', () => {
  it('uses remote-control reason before hardware availability and pending state', () => {
    expect(getPowerDisabledHint(true, node({persistentSession: false}), false, true, t))
      .toBe('Remote control is disconnected.');
  });

  it('uses hardware availability reason before pending state', () => {
    expect(getPowerDisabledHint(true, node({persistentSession: true}), false, true, t))
      .toBe('TX power is unavailable.');
  });

  it('uses pending reason when connection and hardware are available', () => {
    expect(getPowerDisabledHint(true, node({persistentSession: true}), true, true, t))
      .toBe('TX power update is pending.');
  });

  it('returns no hint when power control is enabled', () => {
    expect(getPowerDisabledHint(true, node({persistentSession: true}), true, false, t)).toBeNull();
  });

  it('uses extra-features reason before node-specific reasons', () => {
    expect(getPowerDisabledHint(false, node({persistentSession: false}), false, true, t))
      .toBe('Remote controls require extra features.');
  });
});
