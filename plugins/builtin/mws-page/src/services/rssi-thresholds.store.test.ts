import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DEFAULT_RSSI_THRESHOLDS} from '../components/mws-graph/link-quality';
import {FakePluginStorage} from '../test-support/plugin-storage.fake';
import {SHARED_PLUGIN_STORAGE} from '../tokens';
import {RSSI_THRESHOLDS_KEY, RssiThresholdsStore} from './rssi-thresholds.store';

function stored(good: unknown, fair: unknown, version = 1): string {
  return JSON.stringify({version, thresholds: {good, fair}});
}

describe('RssiThresholdsStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function makeStore(storage: FakePluginStorage): RssiThresholdsStore {
    TestBed.configureTestingModule({
      providers: [
        RssiThresholdsStore,
        {provide: SHARED_PLUGIN_STORAGE, useValue: storage},
      ],
    });

    return TestBed.inject(RssiThresholdsStore);
  }

  it('defaults to −55 and −70 when nothing is stored', async () => {
    const store = makeStore(new FakePluginStorage());

    await store.load();

    expect(store.thresholds()).toEqual(DEFAULT_RSSI_THRESHOLDS);
    expect(store.thresholds()).toEqual({good: -55, fair: -70});
  });

  it('loads stored integer thresholds', async () => {
    const store = makeStore(
      new FakePluginStorage({
        values: {[RSSI_THRESHOLDS_KEY]: stored(-50, -75)},
      }),
    );

    await store.load();

    expect(store.thresholds()).toEqual({good: -50, fair: -75});
  });

  it('falls back to defaults for malformed, unknown or invalid stored data', async () => {
    const cases = [
      '{not-json',
      stored(-50, -75, 2),
      stored(-50, -75).replace('"thresholds"', '"wrong"'),
      stored(-19, -75),
      stored(-50, -101),
      stored(-50.5, -75),
      stored('−50', -75),
      stored(-75, -50),
      stored(-60, -60),
    ];

    for (const value of cases) {
      TestBed.resetTestingModule();

      const store = makeStore(new FakePluginStorage({values: {[RSSI_THRESHOLDS_KEY]: value}}));

      await store.load();

      expect(store.thresholds()).toEqual(DEFAULT_RSSI_THRESHOLDS);
    }
  });

  it('saves valid thresholds immediately and ignores invalid ones', async () => {
    const storage = new FakePluginStorage();
    const store = makeStore(storage);

    store.setThresholds({good: -48, fair: -68});
    await store.flush();

    expect(store.thresholds()).toEqual({good: -48, fair: -68});
    expect(JSON.parse(storage.read(RSSI_THRESHOLDS_KEY) ?? '{}')).toEqual({
      version: 1,
      thresholds: {good: -48, fair: -68},
    });

    store.setThresholds({good: -20, fair: -30});
    store.setThresholds({good: -10, fair: -30});
    await store.flush();

    expect(store.thresholds()).toEqual({good: -20, fair: -30});
    expect(JSON.parse(storage.read(RSSI_THRESHOLDS_KEY) ?? '{}')).toEqual({
      version: 1,
      thresholds: {good: -20, fair: -30},
    });
  });
});
