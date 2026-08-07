import {afterEach, describe, expect, it, vi} from 'vitest';
import {startOptionalStartupWork} from './optional-startup.js';

describe('startOptionalStartupWork', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('contains rejected optional work without throwing', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => startOptionalStartupWork(() => Promise.reject(new Error('backend unavailable')))).not.toThrow();

    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        '[mndw] Optional backend startup work failed; continuing.',
      )
    );

    expect(warning).toHaveBeenCalledWith('[mndw] Optional backend startup work failed; continuing.');
  });
});
