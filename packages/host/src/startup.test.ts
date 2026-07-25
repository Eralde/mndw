import {describe, expect, it, vi} from 'vitest';
import {type StartupDeps, initialize} from './startup.js';

function depsFor(events: string[], authenticated = false, triggerAuthError = false): StartupDeps {
  return {
    initTheme: () => events.push('theme'),
    initPalette: () =>
      Promise.resolve().then(() => events.push('palette'))
        .then(() => undefined),
    checkAuthenticated: () =>
      Promise.resolve().then(() => {
        events.push('auth-check');

        return authenticated;
      }),
    setAuthenticated: (value) => events.push(`set-auth:${value}`),
    initAuthenticated: () =>
      Promise.resolve().then(() => events.push('authenticated-init'))
        .then(() => undefined),
    subscribeAuthErrors: (callback) => {
      events.push('auth-subscribe');

      if (triggerAuthError) {
        callback();
      }
    },
    resetToLogin: () => events.push('reset-login'),
    mountApp: () => events.push('mount'),
  };
}

describe('initialize', () => {
  it('orders theme, palette, auth check, authenticated initialization, subscription, and mount', async () => {
    const events: string[] = [];

    await initialize(depsFor(events, true));

    expect(events).toEqual([
      'theme',
      'palette',
      'auth-check',
      'set-auth:true',
      'authenticated-init',
      'auth-subscribe',
      'mount',
    ]);
  });

  it('does not start auth check until palette initialization resolves', async () => {
    const events: string[] = [];
    let releasePalette: () => void = () => {};
    const palette = new Promise<void>((resolve) => {
      releasePalette = resolve;
    });
    const deps = depsFor(events);

    deps.initPalette = () => palette;

    const pending = initialize(deps);

    await Promise.resolve();
    expect(events).toEqual(['theme']);

    releasePalette();
    await pending;
    expect(events).toContain('auth-check');
  });

  it('continues to auth and mount when palette initialization rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: string[] = [];
    const deps = depsFor(events);

    deps.initPalette = () => Promise.reject(new Error('offline'));

    await initialize(deps);

    expect(events).toContain('auth-check');
    expect(events).toContain('mount');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('resets to login when the auth-error subscription fires', async () => {
    const events: string[] = [];

    await initialize(depsFor(events, false, true));

    expect(events).toContain('reset-login');
  });
});
