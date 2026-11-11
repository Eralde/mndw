import {describe, expect, it, vi} from 'vitest';
import {type StartupDeps, initialize} from './startup.js';

type TestStartupDeps = StartupDeps & {
  getAuthRunGeneration: () => number;
  startAuthRun: () => number;
};

function depsFor(events: string[], authenticated = false, triggerAuthError = false): TestStartupDeps {
  let generation = 0;

  return {
    initLocale: () => {
      events.push('locale');

      return 'en';
    },
    defineUi: () => events.push('define-ui'),
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
    initAuthenticated: () => {
      generation += 1;

      return Promise.resolve().then(() => events.push('authenticated-init'))
        .then(() => undefined);
    },
    getAuthRunGeneration: () => generation,
    startAuthRun: () => {
      generation += 1;

      return generation;
    },
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
  it('mounts an authenticated shell while authenticated initialization is still pending', async () => {
    const events: string[] = [];
    let finishInitialization: () => void = () => {};
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const deps = depsFor(events, true);

    deps.initAuthenticated = () => {
      deps.startAuthRun();
      events.push('authenticated-init-start');

      return initialization;
    };

    const pending = initialize(deps);

    try {
      await vi.waitFor(() => expect(events).toContain('authenticated-init-start'));
      expect(events).toContain('mount');
      expect(events.indexOf('mount')).toBeLessThan(events.indexOf('authenticated-init-start'));
    } finally {
      finishInitialization();
      await pending;
    }
  });

  it('sets up subscriptions and mounts before authenticated initialization', async () => {
    const events: string[] = [];

    await initialize(depsFor(events, true));

    expect(events).toEqual([
      'locale',
      'define-ui',
      'theme',
      'palette',
      'auth-check',
      'set-auth:true',
      'auth-subscribe',
      'mount',
      'authenticated-init',
    ]);
  });

  it('registers ui elements before anything else', async () => {
    const order: string[] = [];

    await initialize({
      initLocale: () => {
        order.push('initLocale');

        return 'en';
      },
      defineUi: () => order.push('defineUi'),
      initTheme: () => order.push('initTheme'),
      initPalette: () =>
        Promise.resolve().then(() => {
          order.push('initPalette');
        }),
      checkAuthenticated: () => Promise.resolve(false),
      setAuthenticated: () => undefined,
      initAuthenticated: () => Promise.resolve(),
      getAuthRunGeneration: () => 0,
      subscribeAuthErrors: () => undefined,
      resetToLogin: () => undefined,
      mountApp: () => order.push('mountApp'),
    });

    expect(order.slice(0, 2)).toEqual(['initLocale', 'defineUi']);
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
    expect(events).toEqual(['locale', 'define-ui', 'theme']);

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

  it('skips authenticated initialization when auth error arrives before mount', async () => {
    const events: string[] = [];

    await initialize(depsFor(events, true, true));

    expect(events).toContain('mount');
    expect(events).toContain('reset-login');
    expect(events).not.toContain('authenticated-init');
  });

  it('does not reset login when a superseded startup auth run rejects', async () => {
    const events: string[] = [];
    let authenticatedState = false;
    let rejectInitialization: (error: Error) => void = () => {};
    const initialization = new Promise<void>((_, reject) => {
      rejectInitialization = reject;
    });
    const deps = depsFor(events, true);

    deps.setAuthenticated = (value) => {
      authenticatedState = value;
      events.push(`set-auth:${value}`);
    };
    deps.initAuthenticated = () => {
      deps.startAuthRun();
      events.push('authenticated-init-start');

      return initialization;
    };

    const pending = initialize(deps);
    await vi.waitFor(() => expect(events).toContain('authenticated-init-start'));

    deps.startAuthRun();
    rejectInitialization(new Error('stale failure'));
    await pending;

    expect(events).not.toContain('reset-login');
    expect(authenticatedState).toBe(true);
  });

  it('resets login when the current startup auth run rejects', async () => {
    const events: string[] = [];
    const deps = depsFor(events, true);

    deps.initAuthenticated = () => {
      deps.startAuthRun();

      return Promise.reject(new Error('current failure'));
    };

    await initialize(deps);

    expect(events).toContain('reset-login');
  });
});
