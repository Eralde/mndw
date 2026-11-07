import {afterEach, describe, expect, it, vi} from 'vitest';
import {getIconSpriteUrl, setIconSpriteUrl, subscribeIconSpriteUrl} from './sprite-config.js';

const URL_A = '/assets/icons.svg';
const URL_B = '/assets/other.svg';

afterEach(() => {
  setIconSpriteUrl('');
});

describe('icon sprite configuration', () => {
  it('starts unconfigured and clears with an empty string', () => {
    expect(getIconSpriteUrl()).toBe('');

    setIconSpriteUrl(URL_A);
    expect(getIconSpriteUrl()).toBe(URL_A);

    setIconSpriteUrl('');
    expect(getIconSpriteUrl()).toBe('');
  });

  it('rejects fragment-bearing URLs', () => {
    expect(() => setIconSpriteUrl(`${URL_A}#mndw-icon-eye`)).toThrow(/fragment/i);
    expect(getIconSpriteUrl()).toBe('');
  });

  it('notifies subscribers when the URL changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeIconSpriteUrl(listener);

    setIconSpriteUrl(URL_A);
    expect(listener).toHaveBeenCalledTimes(1);

    setIconSpriteUrl(URL_A);
    expect(listener).toHaveBeenCalledTimes(1);

    setIconSpriteUrl(URL_B);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setIconSpriteUrl('');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies every subscriber and survives listener removal', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeIconSpriteUrl(first);

    subscribeIconSpriteUrl(second);

    setIconSpriteUrl(URL_A);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    setIconSpriteUrl(URL_B);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('shares the URL and subscribers across independent module instances', async () => {
    const firstInstance = await import('./sprite-config.js');
    const listener = vi.fn();
    const unsubscribe = firstInstance.subscribeIconSpriteUrl(listener);

    try {
      vi.resetModules();

      const secondInstance = await import('./sprite-config.js');

      expect(secondInstance).not.toBe(firstInstance);

      secondInstance.setIconSpriteUrl(URL_A);

      expect(firstInstance.getIconSpriteUrl()).toBe(URL_A);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
