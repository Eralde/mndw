import {beforeEach, describe, expect, it, vi} from 'vitest';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';
import {getNextInstanceId, raiseInstanceCounter} from './widget-counter.js';

const counterKey = (pluginName: string): string => `${PLUGIN_STORAGE_PREFIX}:${pluginName}:counter`;

describe('widget instance counters', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('uses the plugin counter key and returns sequential positive instance IDs', () => {
    const pluginName = 'weather';

    expect(getNextInstanceId(pluginName)).toBe('weather:1');
    expect(localStorage.getItem(counterKey(pluginName))).toBe('1');
    expect(getNextInstanceId(pluginName)).toBe('weather:2');
    expect(localStorage.getItem(counterKey(pluginName))).toBe('2');
  });

  it('keeps counters independent for each plugin', () => {
    expect(getNextInstanceId('weather-independent')).toBe('weather-independent:1');
    expect(getNextInstanceId('clock-independent')).toBe('clock-independent:1');
    expect(getNextInstanceId('weather-independent')).toBe('weather-independent:2');
  });

  it.each(['malformed', '', ' ', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1)])(
    'recovers an invalid stored counter %j as zero',
    (storedCounter) => {
      const pluginName = `plugin-${storedCounter || 'empty'}`;

      localStorage.setItem(counterKey(pluginName), storedCounter);

      expect(getNextInstanceId(pluginName)).toBe(`${pluginName}:1`);
      expect(localStorage.getItem(counterKey(pluginName))).toBe('1');
    },
  );

  it('throws when the effective counter reaches Number.MAX_SAFE_INTEGER', () => {
    localStorage.setItem(counterKey('weather-overflow'), String(Number.MAX_SAFE_INTEGER));

    expect(() => getNextInstanceId('weather-overflow')).toThrowError(
      new RangeError('Widget instance counter exhausted for "weather-overflow"'),
    );
  });

  it('logs failed reads and keeps a monotonic in-memory counter for the session', () => {
    const error = new Error('read denied');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw error;
    });

    expect(getNextInstanceId('weather-read-failure')).toBe('weather-read-failure:1');
    expect(getNextInstanceId('weather-read-failure')).toBe('weather-read-failure:2');
    expect(consoleError).toHaveBeenCalledWith(
      '[mndw] Failed to read widget counter for "weather-read-failure":',
      error,
    );
  });

  it('logs failed writes and keeps a monotonic in-memory counter for the session', () => {
    const error = new Error('write denied');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw error;
    });

    expect(getNextInstanceId('weather-write-failure')).toBe('weather-write-failure:1');
    expect(getNextInstanceId('weather-write-failure')).toBe('weather-write-failure:2');
    expect(consoleError).toHaveBeenCalledWith(
      '[mndw] Failed to write widget counter for "weather-write-failure":',
      error,
    );
  });

  it('only raises the stored counter when restoring a valid larger counter', () => {
    raiseInstanceCounter('weather-restore', 4);
    raiseInstanceCounter('weather-restore', 2);

    expect(getNextInstanceId('weather-restore')).toBe('weather-restore:5');
  });

  it('retains a storage high-water mark when a later read fails after restoring', () => {
    const pluginName = 'weather-storage-transition';
    const error = new Error('read denied');

    localStorage.setItem(counterKey(pluginName), '4');

    raiseInstanceCounter(pluginName, 2);
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw error;
    });

    expect(getNextInstanceId(pluginName)).toBe(`${pluginName}:5`);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'ignores and logs invalid restored counter %j',
    (restoredCounter) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pluginName = `weather-invalid-${String(restoredCounter)}`;

      raiseInstanceCounter(pluginName, restoredCounter);

      expect(getNextInstanceId(pluginName)).toBe(`${pluginName}:1`);
      expect(consoleError).toHaveBeenCalledWith(
        `[mndw] Ignoring invalid restored widget counter for "${pluginName}":`,
        restoredCounter,
      );
    },
  );
});
