import {describe, expect, it} from 'vitest';
import {PERSISTENT_RCI_CAPABILITIES} from '@mndw/sdk-internal';
import {decodeMgmtList, decodeMgmtListEntry} from './mgmt-list-schema.js';

const widgetEntry = {
  name: 'demo',
  type: 'widget',
  version: '1.0.0',
  label: 'Demo',
  entry: 'index.js',
  source: 'builtin',
  approval: 'approved',
  enabled: true,
  depsStatus: 'ready',
  backend: {routes: {}},
  size: {w: 4, h: 2},
};

describe('decodeMgmtList', () => {
  it('decodes a well-formed widget list entry', () => {
    const entries = decodeMgmtList({plugins: [widgetEntry]});

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({name: 'demo', type: 'widget', source: 'builtin'});
  });

  it('accepts optional installedAt and omits it when absent', () => {
    const installedAt = '2026-09-01T09:30:00Z';
    const withTime = decodeMgmtListEntry({...widgetEntry, installedAt});
    const withoutTime = decodeMgmtListEntry(widgetEntry);

    expect(withTime.installedAt).toBe(installedAt);
    expect(withoutTime).not.toHaveProperty('installedAt');
  });

  it('preserves optional description and ignores retired icon wire data', () => {
    const entry = decodeMgmtListEntry({...widgetEntry, description: 'Shows device status.', icon: 'chart'});

    expect(entry.description).toBe('Shows device status.');
    expect(entry).not.toHaveProperty('icon');
  });

  it('decodes a page entry with a route', () => {
    const page = {...widgetEntry, type: 'page', route: '/demo', size: undefined};

    delete (page as Record<string, unknown>).size;

    const entries = decodeMgmtList({plugins: [page]});

    expect(entries[0]).toMatchObject({type: 'page', route: '/demo'});
  });

  it('rejects an unknown source', () => {
    expect(() => decodeMgmtList({plugins: [{...widgetEntry, source: 'evil'}]})).toThrow();
  });

  it('rejects a denied approval value', () => {
    expect(() => decodeMgmtList({plugins: [{...widgetEntry, approval: 'denied'}]})).toThrow();
  });

  it('rejects a widget entry missing size', () => {
    const bad = {...widgetEntry} as Record<string, unknown>;

    delete bad.size;

    expect(() => decodeMgmtList({plugins: [bad]})).toThrow();
  });

  it('rejects a payload without a plugins array', () => {
    expect(() => decodeMgmtList({})).toThrow();
    expect(() => decodeMgmtList({plugins: 'nope'})).toThrow();
  });

  it('accepts partial capability grants, host catalog data, and runtime startedAt', () => {
    const entries = decodeMgmtList({plugins: [{
      ...widgetEntry,
      capabilityGrants: {'persistent-rci-session:read': true},
      catalogBaseUrl: '/catalogs/demo',
      runtime: {
        state: 'ready',
        restartCount: 0,
        consecutiveFailures: 0,
        startedAt: '2026-08-15T10:00:00Z',
      },
    }]});

    expect(entries[0]?.capabilityGrants).toEqual({'persistent-rci-session:read': true});
    expect(entries[0]?.catalogBaseUrl).toBe('/catalogs/demo');
    expect(entries[0]?.runtime?.startedAt).toBe('2026-08-15T10:00:00Z');
  });

  it('accepts every SDK persistent RCI capability grant', () => {
    for (const capability of PERSISTENT_RCI_CAPABILITIES) {
      const entries = decodeMgmtList({plugins: [{
        ...widgetEntry,
        capabilityGrants: {[capability]: true},
      }]});

      expect(entries[0]?.capabilityGrants).toEqual({[capability]: true});
    }
  });

  it('rejects persistent capability grants outside the SDK capability set', () => {
    expect(() =>
      decodeMgmtList({plugins: [{
        ...widgetEntry,
        capabilities: ['persistent-rci-session:admin'],
        capabilityGrants: {'persistent-rci-session:admin': true},
      }]})
    ).toThrow();
  });

  it('keeps event declarations separate from persistent capability grants', () => {
    const entries = decodeMgmtList({plugins: [{
      ...widgetEntry,
      capabilities: ['events:wan,wifi,net'],
      capabilityGrants: {},
    }]});

    expect(entries[0]?.capabilities).toEqual(['events:wan,wifi,net']);
    expect(entries[0]?.capabilityGrants).toEqual({});
    expect(() =>
      decodeMgmtList({plugins: [{
        ...widgetEntry,
        capabilityGrants: {'events:wan': true},
      }]})
    ).toThrow();
  });
});

describe('decodeMgmtListEntry', () => {
  it('decodes a single list-shaped mutation response', () => {
    expect(decodeMgmtListEntry(widgetEntry)).toMatchObject({name: 'demo', type: 'widget'});
  });

  it('decodes an entry when optional lock is absent', () => {
    expect(decodeMgmtListEntry(widgetEntry)).not.toHaveProperty('lock');
  });

  it('preserves an optional plugin lock', () => {
    const lock = {sdkVersion: '1.0.0', sharedDependencies: {rxjs: '7.8.2'}};

    expect(decodeMgmtListEntry({...widgetEntry, lock}).lock).toEqual(lock);
  });

  it('rejects malformed single-entry responses', () => {
    expect(() => decodeMgmtListEntry({...widgetEntry, backend: null})).toThrow();
  });
});
