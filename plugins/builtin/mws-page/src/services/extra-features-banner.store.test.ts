import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {FakePluginStorage} from '../test-support/plugin-storage.fake';
import {PLUGIN_STORAGE} from '../tokens';
import {EXTRA_FEATURES_BANNER_DISMISSED_KEY, ExtraFeaturesBannerStore} from './extra-features-banner.store';

describe('ExtraFeaturesBannerStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const createStore = (storage: FakePluginStorage): ExtraFeaturesBannerStore => {
    TestBed.configureTestingModule({providers: [
      ExtraFeaturesBannerStore,
      {provide: PLUGIN_STORAGE, useValue: storage},
    ]});

    return TestBed.inject(ExtraFeaturesBannerStore);
  };

  it.each([
    [undefined, false],
    ['true', true],
    ['false', false],
    ['', false],
  ])('loads %s as dismissed=%s', async (value, dismissed) => {
    const storage = new FakePluginStorage(
      value === undefined ? {} : {values: {
        [EXTRA_FEATURES_BANNER_DISMISSED_KEY]: value,
      }},
    );
    const store = createStore(storage);

    await store.load();

    expect(store.dismissed()).toBe(dismissed);
    expect(store.loaded()).toBe(true);
  });

  it('keeps loaded false until a pending read settles', async () => {
    const storage = new FakePluginStorage({mode: 'resolve-on-demand'});
    const store = createStore(storage);
    const loading = store.load();

    expect(store.loaded()).toBe(false);
    storage.resolveGet(null);
    await loading;

    expect(store.loaded()).toBe(true);
  });

  it('treats a read rejection as not dismissed', async () => {
    const storage = new FakePluginStorage();

    storage.get.mockRejectedValueOnce(new Error('read failed'));

    const store = createStore(storage);

    await store.load();

    expect(store.dismissed()).toBe(false);
    expect(store.loaded()).toBe(true);
  });

  it('dismisses in memory immediately and writes the exact key/value', async () => {
    const storage = new FakePluginStorage();
    const store = createStore(storage);

    store.dismiss();

    expect(store.dismissed()).toBe(true);
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledWith(EXTRA_FEATURES_BANNER_DISMISSED_KEY, 'true'));
  });

  it('does not reopen after a failed dismissal write', async () => {
    const storage = new FakePluginStorage();

    storage.set.mockRejectedValueOnce(new Error('write failed'));

    const store = createStore(storage);

    store.dismiss();
    await Promise.resolve();

    expect(store.dismissed()).toBe(true);
  });

  it('isolates dismissal state between storage instances', async () => {
    const first = new FakePluginStorage();
    const second = new FakePluginStorage();
    const firstStore = createStore(first);

    firstStore.dismiss();
    await Promise.resolve();

    TestBed.resetTestingModule();

    const secondStore = createStore(second);

    await secondStore.load();

    expect(secondStore.dismissed()).toBe(false);
  });
});
