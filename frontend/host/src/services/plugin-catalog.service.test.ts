import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  PLUGIN_CATALOG_TIMEOUT_MS,
  type PluginCatalogService,
  createPluginCatalogService,
  createPluginCatalogSource,
  createPluginI18n,
  formatPluginManifestText,
  formatPluginTranslation,
} from './plugin-catalog.service.js';
import {createPluginLifetime} from '../runtime/plugin-lifetime.js';

const source = createPluginCatalogSource('demo', '1.2.3', '/plugins/demo', {
  defaultLocale: 'en',
  locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'},
});

const nativeSetTimeout = globalThis.setTimeout;
const nativeQueueMicrotask = globalThis.queueMicrotask;

const receiverSensitiveSetTimeout = function(
  this: unknown,
  callback: () => void,
  delay: number,
): ReturnType<typeof globalThis.setTimeout> {
  if (this !== globalThis) {
    throw new TypeError('Illegal invocation');
  }

  return nativeSetTimeout.call(globalThis, callback, delay);
} as typeof globalThis.setTimeout;

const receiverSensitiveQueueMicrotask = function(this: unknown, callback: VoidFunction): void {
  if (this !== globalThis) {
    throw new TypeError('Illegal invocation');
  }

  nativeQueueMicrotask.call(globalThis, callback);
} as typeof globalThis.queueMicrotask;

if (source === undefined) {
  throw new Error('test source was not created');
}

let catalogService: PluginCatalogService;

beforeEach(() => {
  catalogService = createPluginCatalogService();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('plugin catalog loading', () => {
  it('uses manifest label and description as fallback until reserved catalog keys load', async () => {
    catalogService = createPluginCatalogService({fetchCatalog: () => Promise.resolve({})});
    const cell = catalogService.createPluginCatalogCell(source, 'en');

    expect(formatPluginManifestText(cell, 'manifest.label', 'Manifest Label', 'en')).toBe('Manifest Label');
    expect(formatPluginManifestText(cell, 'manifest.description', 'Manifest description.', 'en'))
      .toBe('Manifest description.');

    await catalogService.loadInitialPluginCatalog(cell, 'en');

    expect(formatPluginManifestText(cell, 'manifest.label', 'Manifest Label', 'en')).toBe('Manifest Label');
    expect(formatPluginManifestText(cell, 'manifest.description', 'Manifest description.', 'en'))
      .toBe('Manifest description.');
  });

  it('uses manifest text when a loaded catalog omits a reserved key', async () => {
    const cell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'en');

    expect(formatPluginManifestText(cell, 'manifest.label', 'Manifest Label', 'en')).toBe('Manifest Label');
  });

  it('completes i18n.locale$ when the plugin lifetime ends', () => {
    const lifetime = createPluginLifetime();
    const i18n = createPluginI18n(undefined, () => 'en', () => () => {}, lifetime);
    const complete = vi.fn();

    i18n.locale$.subscribe({complete});
    lifetime.end();

    expect(complete).toHaveBeenCalledOnce();
  });

  it('emits a locale only after its plugin catalog has been applied', async () => {
    catalogService = createPluginCatalogService({fetchCatalog: (url) =>
      Promise.resolve(
        url.includes('/ru.json') ? {title: 'Привет'} : {title: 'Hello'},
      )});
    const cell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'en');

    let activeLocale = 'en';
    const lifetime = createPluginLifetime();
    const i18n = createPluginI18n(cell, () => activeLocale, () => () => {}, lifetime);
    const seen: string[] = [];

    i18n.locale$.subscribe((locale) => seen.push(`${locale}:${i18n.t('title')}`));

    const generation = catalogService.preparePluginCatalogGeneration('ru');

    await generation.promise;

    expect(seen).toEqual(['en:Hello']);

    catalogService.commitPluginCatalogGeneration(generation, () => {
      activeLocale = 'ru';
    });

    expect(seen).toEqual(['en:Hello', 'ru:Привет']);
    lifetime.end();
  });

  it('emits a failed locale load once after applying the fallback catalog', async () => {
    catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      if (url.includes('/ru.json')) {
        return Promise.reject(new Error('offline'));
      }

      return Promise.resolve({title: 'Hello'});
    }});

    const cell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'en');

    let activeLocale = 'en';
    const lifetime = createPluginLifetime();
    const i18n = createPluginI18n(cell, () => activeLocale, () => () => {}, lifetime);
    const seen: string[] = [];

    i18n.locale$.subscribe((locale) => {
      seen.push(`${locale}:${cell.readCurrentState().fallbackStatus}:${i18n.t('title')}`);
    });

    const generation = catalogService.preparePluginCatalogGeneration('ru');

    await generation.promise;

    catalogService.commitPluginCatalogGeneration(generation, () => {
      activeLocale = 'ru';
    });

    expect(seen).toEqual(['en:primary:Hello', 'ru:default:Hello']);
    lifetime.end();
  });

  it('loads catalogs when browser timers require the global receiver', async () => {
    vi.stubGlobal('setTimeout', receiverSensitiveSetTimeout);
    catalogService = createPluginCatalogService({fetchCatalog: () => Promise.resolve({title: 'Hello'})});

    const cell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'en');

    expect(cell.readCurrentState().primaryCatalog).toEqual({title: 'Hello'});
    expect(formatPluginTranslation(cell, 'title', undefined, 'en')).toBe('Hello');
  });

  it('resolves exact and language-only catalog paths and loads the eager default', async () => {
    const urls: string[] = [];

    catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      urls.push(url);

      if (url.includes('/ru.json')) {
        return Promise.resolve({title: 'Привет'});
      }

      return Promise.resolve({title: 'Hello', count: '{count, number}'});
    }});

    const ruCell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(ruCell, 'ru-RU');

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

    const cell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'en');

    expect(formatPluginTranslation(cell, 'field.host-ip', undefined, 'en')).toBe('Host IP');
  });

  it('maps pseudo locale through normal language-only resolution', async () => {
    const urls: string[] = [];

    catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      urls.push(url);

      return Promise.resolve({title: 'Hello'});
    }});

    const cell = catalogService.createPluginCatalogCell(source, 'en-XA');

    await catalogService.loadInitialPluginCatalog(cell, 'en-XA');

    expect(urls).toEqual(['/plugins/demo/i18n/en.json?v=1.2.3']);
    expect(cell.readCurrentState().resolvedCatalogLocale).toBe('en');
  });

  it('memoizes successes by plugin, revision, and locale but retries failures', async () => {
    const fetcher = vi.fn(() => Promise.resolve({title: 'Hello'}));

    catalogService = createPluginCatalogService({fetchCatalog: fetcher});
    await catalogService.loadInitialPluginCatalog(catalogService.createPluginCatalogCell(source, 'en'), 'en');
    await catalogService.loadInitialPluginCatalog(catalogService.createPluginCatalogCell(source, 'en'), 'en');

    expect(fetcher).toHaveBeenCalledTimes(1);

    const failing = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({title: 'Recovered'});

    catalogService = createPluginCatalogService({fetchCatalog: failing});

    const first = catalogService.createPluginCatalogCell({...source, revision: '2.0.0'}, 'en');
    const second = catalogService.createPluginCatalogCell({...source, revision: '2.0.0'}, 'en');

    await catalogService.loadInitialPluginCatalog(first, 'ru', 20);
    await catalogService.loadInitialPluginCatalog(second, 'ru', 20);

    expect(failing).toHaveBeenCalledTimes(3);
    expect(second.readCurrentState().primaryCatalog).toEqual({title: 'Recovered'});
  });

  it('falls back to the default catalog and then to the key', async () => {
    catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      if (url.includes('/ru.json')) {
        return Promise.reject(new Error('timeout'));
      }

      return Promise.resolve({known: 'English {count, number}'});
    }});

    const cell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'ru', 20);

    expect(cell.readCurrentState().fallbackStatus).toBe('default');
    expect(formatPluginTranslation(cell, 'known', {count: 1234}, 'ru')).toContain('1');
    expect(formatPluginTranslation(cell, 'missing', undefined, 'ru')).toBe('missing');
  });

  it('never renders an empty string when both catalogs are unavailable', async () => {
    catalogService = createPluginCatalogService({fetchCatalog: () => Promise.reject(new Error('offline'))});

    const cell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'ru', 20);

    expect(cell.readCurrentState().fallbackStatus).toBe('key');
    expect(formatPluginTranslation(cell, 'demo.title', undefined, 'ru')).toBe('demo.title');
  });
});

describe('plugin catalog generation', () => {
  it('does not emit a superseded locale when a newer generation commits', async () => {
    const extendedSource = createPluginCatalogSource('demo', '1.2.3', '/plugins/demo', {
      defaultLocale: 'en',
      locales: {en: 'i18n/en.json', ru: 'i18n/ru.json', de: 'i18n/de.json'},
    });

    if (extendedSource === undefined) {
      throw new Error('test source was not created');
    }

    let resolveRu: ((catalog: Record<string, string>) => void) | undefined;

    catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      if (url.includes('/ru.json')) {
        return new Promise((resolve) => {
          resolveRu = resolve;
        });
      }

      return Promise.resolve({title: url.includes('/de.json') ? 'Guten Tag' : 'Hello'});
    }});

    const cell = catalogService.createPluginCatalogCell(extendedSource, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'en');

    let activeLocale = 'en';
    const lifetime = createPluginLifetime();
    const i18n = createPluginI18n(cell, () => activeLocale, () => () => {}, lifetime);
    const seen: string[] = [];

    i18n.locale$.subscribe((locale) => seen.push(locale));

    const superseded = catalogService.preparePluginCatalogGeneration('ru');

    catalogService.discardPluginCatalogGeneration(superseded);
    resolveRu?.({title: 'Привет'});

    const current = catalogService.preparePluginCatalogGeneration('de');

    await current.promise;
    catalogService.commitPluginCatalogGeneration(current, () => {
      activeLocale = 'de';
    });

    expect(seen).toEqual(['en', 'de']);
    lifetime.end();
  });

  it('does not emit catalog locale changes after the plugin lifetime ends', async () => {
    catalogService = createPluginCatalogService({fetchCatalog: () => Promise.resolve({title: 'Hello'})});

    const cell = catalogService.createPluginCatalogCell(source, 'en');

    await catalogService.loadInitialPluginCatalog(cell, 'en');

    let activeLocale = 'en';
    const lifetime = createPluginLifetime();
    const i18n = createPluginI18n(cell, () => activeLocale, () => () => {}, lifetime);
    const seen: string[] = [];

    i18n.locale$.subscribe((locale) => seen.push(locale));
    lifetime.end();

    const generation = catalogService.preparePluginCatalogGeneration('ru');

    await generation.promise;
    catalogService.commitPluginCatalogGeneration(generation, () => {
      activeLocale = 'ru';
    });

    expect(seen).toEqual(['en']);
  });

  it('settles generations when browser microtasks require the global receiver', async () => {
    vi.stubGlobal('setTimeout', receiverSensitiveSetTimeout);
    vi.stubGlobal('queueMicrotask', receiverSensitiveQueueMicrotask);
    catalogService = createPluginCatalogService({fetchCatalog: () => Promise.resolve({title: 'Hello'})});

    const cell = catalogService.createPluginCatalogCell(source, 'en');
    const generation = catalogService.preparePluginCatalogGeneration('en');

    await generation.promise;
    catalogService.commitPluginCatalogGeneration(generation, () => {});

    expect(formatPluginTranslation(cell, 'title', undefined, 'en')).toBe('Hello');
  });

  it('commits cells atomically after the dynamic barrier and lets late cells enroll', async () => {
    const resolveRu: Array<(catalog: Record<string, string>) => void> = [];

    catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      if (url.includes('/ru.json')) {
        return new Promise((resolve) => {
          resolveRu.push(resolve);
        });
      }

      return Promise.resolve({title: 'Hello'});
    }});

    const first = catalogService.createPluginCatalogCell(source, 'en');
    const generation = catalogService.preparePluginCatalogGeneration('ru');
    const callbacks: string[] = [];

    first.subscribe(() => callbacks.push('first'));

    const late = catalogService.createPluginCatalogCell({...source, name: 'late'}, 'en');

    late.subscribe(() => callbacks.push('late'));

    for (const resolve of resolveRu) {
      resolve({title: 'Привет'});
    }

    await generation.promise;

    expect(first.readCurrentState().hostLocale).toBe('en');
    expect(late.readCurrentState().hostLocale).toBe('en');

    catalogService.commitPluginCatalogGeneration(generation, () => {
      expect(callbacks).toEqual([]);
    });

    expect(first.readCurrentState().hostLocale).toBe('ru');
    expect(late.readCurrentState().hostLocale).toBe('ru');
    expect(callbacks).toEqual(['first', 'late']);
  });

  it('enforces one shared bounded deadline', async () => {
    vi.useFakeTimers();
    catalogService = createPluginCatalogService({fetchCatalog: () => new Promise(() => {})});

    const cell = catalogService.createPluginCatalogCell(source, 'en');
    const generation = catalogService.preparePluginCatalogGeneration('ru');
    const completion = vi.fn();

    void generation.promise.then(completion);

    await vi.advanceTimersByTimeAsync(PLUGIN_CATALOG_TIMEOUT_MS);
    await generation.promise;

    expect(completion).toHaveBeenCalledTimes(1);
    catalogService.commitPluginCatalogGeneration(generation, () => {});
    expect(cell.readCurrentState().fallbackStatus).toBe('key');
  });
});
