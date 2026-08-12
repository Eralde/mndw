import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  PLUGIN_CATALOG_TIMEOUT_MS,
  commitPluginCatalogGeneration,
  createPluginCatalogCell,
  createPluginCatalogSource,
  formatPluginTranslation,
  loadInitialPluginCatalog,
  preparePluginCatalogGeneration,
  resetPluginCatalogServiceForTests,
  setPluginCatalogFetchForTests,
} from './plugin-catalog.service.js';

const source = createPluginCatalogSource('demo', '1.2.3', '/plugins/demo', {
  defaultLocale: 'en',
  locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'},
});

if (source === undefined) {
  throw new Error('test source was not created');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPluginCatalogServiceForTests();
});

describe('plugin catalog loading', () => {
  it('resolves exact and language-only catalog paths and loads the eager default', async () => {
    const urls: string[] = [];

    setPluginCatalogFetchForTests((url) => {
      urls.push(url);

      if (url.includes('/ru.json')) {
        return Promise.resolve({title: 'Привет'});
      }

      return Promise.resolve({title: 'Hello', count: '{count, number}'});
    });

    const ruCell = createPluginCatalogCell(source, 'en');
    await loadInitialPluginCatalog(ruCell, 'ru-RU');

    expect(urls).toEqual([
      '/plugins/demo/i18n/ru.json?v=1.2.3',
      '/plugins/demo/i18n/en.json?v=1.2.3',
    ]);
    expect(ruCell.readCurrentState()).toMatchObject({
      hostLocale: 'ru-RU',
      resolvedCatalogLocale: 'ru',
      fallbackStatus: 'primary',
      primaryCatalog: {title: 'Привет'},
      defaultCatalog: {title: 'Hello'},
    });
  });

  it('flattens nested catalogs while preserving dotted kebab-case message IDs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({field: {'host-ip': 'Host IP'}}),
        })
      ),
    );

    const cell = createPluginCatalogCell(source, 'en');
    await loadInitialPluginCatalog(cell, 'en');

    expect(formatPluginTranslation(cell, 'field.host-ip', undefined, 'en')).toBe('Host IP');
  });

  it('maps pseudo locale through normal language-only resolution', async () => {
    const urls: string[] = [];

    setPluginCatalogFetchForTests((url) => {
      urls.push(url);

      return Promise.resolve({title: 'Hello'});
    });

    const cell = createPluginCatalogCell(source, 'en-XA');
    await loadInitialPluginCatalog(cell, 'en-XA');

    expect(urls).toEqual(['/plugins/demo/i18n/en.json?v=1.2.3']);
    expect(cell.readCurrentState().resolvedCatalogLocale).toBe('en');
  });

  it('memoizes successes by plugin, version, and locale but retries failures', async () => {
    const fetcher = vi.fn(() => Promise.resolve({title: 'Hello'}));

    setPluginCatalogFetchForTests(fetcher);
    await loadInitialPluginCatalog(createPluginCatalogCell(source, 'en'), 'en');
    await loadInitialPluginCatalog(createPluginCatalogCell(source, 'en'), 'en');

    expect(fetcher).toHaveBeenCalledTimes(1);

    const failing = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({title: 'Recovered'});

    setPluginCatalogFetchForTests(failing);
    const first = createPluginCatalogCell({...source, version: '2.0.0'}, 'en');
    const second = createPluginCatalogCell({...source, version: '2.0.0'}, 'en');
    await loadInitialPluginCatalog(first, 'ru', 20);
    await loadInitialPluginCatalog(second, 'ru', 20);

    expect(failing).toHaveBeenCalledTimes(3);
    expect(second.readCurrentState().primaryCatalog).toEqual({title: 'Recovered'});
  });

  it('falls back to the default catalog and then to the key', async () => {
    setPluginCatalogFetchForTests((url) => {
      if (url.includes('/ru.json')) {
        return Promise.reject(new Error('timeout'));
      }

      return Promise.resolve({known: 'English {count, number}'});
    });

    const cell = createPluginCatalogCell(source, 'en');
    await loadInitialPluginCatalog(cell, 'ru', 20);

    expect(cell.readCurrentState().fallbackStatus).toBe('default');
    expect(formatPluginTranslation(cell, 'known', {count: 1234}, 'ru')).toContain('1');
    expect(formatPluginTranslation(cell, 'missing', undefined, 'ru')).toBe('missing');
  });

  it('never renders an empty string when both catalogs are unavailable', async () => {
    setPluginCatalogFetchForTests(() => Promise.reject(new Error('offline')));

    const cell = createPluginCatalogCell(source, 'en');
    await loadInitialPluginCatalog(cell, 'ru', 20);

    expect(cell.readCurrentState().fallbackStatus).toBe('key');
    expect(formatPluginTranslation(cell, 'demo.title', undefined, 'ru')).toBe('demo.title');
  });
});

describe('plugin catalog generation', () => {
  it('commits cells atomically after the dynamic barrier and lets late cells enroll', async () => {
    const resolveRu: Array<(catalog: Record<string, string>) => void> = [];
    setPluginCatalogFetchForTests((url) => {
      if (url.includes('/ru.json')) {
        return new Promise((resolve) => {
          resolveRu.push(resolve);
        });
      }

      return Promise.resolve({title: 'Hello'});
    });

    const first = createPluginCatalogCell(source, 'en');
    const generation = preparePluginCatalogGeneration('ru');
    const callbacks: string[] = [];
    first.subscribe(() => callbacks.push('first'));

    const late = createPluginCatalogCell({...source, name: 'late'}, 'en');
    late.subscribe(() => callbacks.push('late'));

    for (const resolve of resolveRu) {
      resolve({title: 'Привет'});
    }
    await generation.promise;

    expect(first.readCurrentState().hostLocale).toBe('en');
    expect(late.readCurrentState().hostLocale).toBe('en');

    commitPluginCatalogGeneration(generation, () => {
      expect(callbacks).toEqual([]);
    });

    expect(first.readCurrentState().hostLocale).toBe('ru');
    expect(late.readCurrentState().hostLocale).toBe('ru');
    expect(callbacks).toEqual(['first', 'late']);
  });

  it('enforces one shared bounded deadline', async () => {
    vi.useFakeTimers();
    setPluginCatalogFetchForTests(() => new Promise(() => {}));

    const cell = createPluginCatalogCell(source, 'en');
    const generation = preparePluginCatalogGeneration('ru');
    const completion = vi.fn();
    void generation.promise.then(completion);

    await vi.advanceTimersByTimeAsync(PLUGIN_CATALOG_TIMEOUT_MS);
    await generation.promise;

    expect(completion).toHaveBeenCalledTimes(1);
    commitPluginCatalogGeneration(generation, () => {});
    expect(cell.readCurrentState().fallbackStatus).toBe('key');
  });
});
