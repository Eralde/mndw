import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {FakePluginStorage} from '../test-support/plugin-storage.fake';
import {PLUGIN_STORAGE} from '../tokens';
import {NODE_POSITIONS_KEY, NodePositionStore} from './node-position.store';

function stored(positions: Record<string, {x: number; y: number; updatedAt: number}>): string {
  return JSON.stringify({version: 1, positions});
}

describe('NodePositionStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeStorage(value: string | null = null): FakePluginStorage {
    return new FakePluginStorage({values: value === null ? {} : {[NODE_POSITIONS_KEY]: value}});
  }

  function makeStore(storage: FakePluginStorage): NodePositionStore {
    TestBed.configureTestingModule({providers: [NodePositionStore, {provide: PLUGIN_STORAGE, useValue: storage}]});

    return TestBed.inject(NodePositionStore);
  }

  it('loads valid finite positions and ignores malformed entries', async () => {
    const storage = makeStorage(stored({
      good: {x: 12, y: 24, updatedAt: 2},
      bad: {x: Number.NaN, y: 4, updatedAt: 3},
    }));
    const store = makeStore(storage);

    expect(store.positions().size).toBe(0);
    await store.load();

    expect(store.loadOutcome()).toBe('applied');
    expect(store.get('good')).toEqual({x: 12, y: 24});
    expect(store.get('bad')).toBeUndefined();
  });

  it('settles empty or rejected loads as none', async () => {
    const storage = makeStorage();
    const store = makeStore(storage);

    await store.load();
    expect(store.loadOutcome()).toBe('none');

    TestBed.resetTestingModule();

    const rejected = new FakePluginStorage({mode: 'immediate'});

    rejected.get.mockRejectedValueOnce(new Error('no storage'));

    const rejectedStore = makeStore(rejected);

    await rejectedStore.load();
    expect(rejectedStore.loadOutcome()).toBe('none');
    expect(rejectedStore.positions().size).toBe(0);
  });

  it('updates memory synchronously and debounces one write', async () => {
    const storage = makeStorage();
    const store = makeStore(storage);

    store.set('node', {x: 1, y: 2});
    expect(store.get('node')).toEqual({x: 1, y: 2});
    expect(storage.set).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(storage.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await store.flush();

    expect(storage.set).toHaveBeenCalledOnce();
    expect(JSON.parse(storage.read(NODE_POSITIONS_KEY) ?? '{}').positions.node).toMatchObject({x: 1, y: 2});
  });

  it('clears positions through storage delete and guards late loads', async () => {
    const storage = new FakePluginStorage({mode: 'resolve-on-demand'});
    const store = makeStore(storage);
    const loading = store.load();

    store.set('node', {x: 4, y: 5});
    storage.resolveGet(stored({old: {x: 1, y: 1, updatedAt: 1}}));
    await loading;

    expect(store.loadOutcome()).toBe('none');
    expect(store.get('node')).toEqual({x: 4, y: 5});
    await store.clear();
    expect(storage.delete).toHaveBeenCalledWith(NODE_POSITIONS_KEY);
    expect(store.positions().size).toBe(0);
  });

  it('retries one failed write and degrades after a second failure', async () => {
    const storage = makeStorage();

    storage.set.mockRejectedValue(new Error('write failed'));

    const store = makeStore(storage);

    store.set('node', {x: 1, y: 2});
    await vi.advanceTimersByTimeAsync(500);
    await store.flush();

    expect(storage.set).toHaveBeenCalledTimes(2);
    expect(store.persistDegraded()).toBe(true);

    storage.set.mockResolvedValue(undefined);
    store.set('node', {x: 2, y: 3});
    await vi.advanceTimersByTimeAsync(500);
    await store.flush();
    expect(store.persistDegraded()).toBe(false);
  });
});
