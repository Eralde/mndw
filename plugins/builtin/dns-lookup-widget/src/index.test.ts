// @vitest-environment happy-dom
import {type BackendClient, MNDW_TOKENS, type PluginContext} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {describe, expect, it, vi} from 'vitest';
import enCatalog from '../i18n/en.json';
import {createInstance} from './index.js';

function fakeContext(overrides?: Partial<BackendClient>): PluginContext {
  const fetch = vi.fn().mockResolvedValue(new Response('{"method":"GET"}'));

  return {
    rciManager: {} as PluginContext['rciManager'],
    storage: {get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn(), keys: vi.fn()},
    sharedStorage: {get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn(), keys: vi.fn()},
    hostInfo: {deviceName: 'test-device', vendor: 'Keenetic', firmwareVersion: '4.2', theme: 'light'},
    injector: {get: vi.fn(), has: vi.fn()},
    instanceId: 'test-id',
    onThemeChange: vi.fn(),
    getTokens: vi.fn(() => MNDW_TOKENS),
    onPaletteChange: vi.fn(() => () => {}),
    overlay: {} as PluginContext['overlay'],
    backend: {fetch, socket: vi.fn(), ...overrides} as BackendClient,
    i18n: createTestI18n(enCatalog),
  };
}

function queryElement<T extends Element>(container: Element, selector: string): T {
  const element = container.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

describe('createInstance', () => {
  it('renders idle view on mount', () => {
    const container = document.createElement('div');
    const ctx = fakeContext();
    const instance = createInstance(container, ctx);

    expect(container.querySelector('.mndw-dns-lookup-widget')).not.toBeNull();
    expect(container.textContent).toContain('Enter a hostname');
    expect(container.querySelector('.mndw-dns-lookup-widget__input')).not.toBeNull();
    expect(container.querySelector('.mndw-dns-lookup-widget__btn')).not.toBeNull();

    instance.unmount();
    expect(container.children.length).toBe(0);
  });

  it('shows loading state when lookup is clicked', async () => {
    const container = document.createElement('div');
    const ctx = fakeContext();
    const backend = ctx.backend;

    createInstance(container, ctx);

    const input = queryElement<HTMLInputElement>(container, '.mndw-dns-lookup-widget__input');
    const btn = queryElement<HTMLButtonElement>(container, '.mndw-dns-lookup-widget__btn');

    input.value = 'example.com';
    btn.click();

    expect(container.textContent).toContain('Looking up example.com');

    await vi.waitFor(() => {
      const backendFetch = backend === undefined ? undefined : Reflect.get(backend, 'fetch');

      expect(backendFetch).toHaveBeenCalledWith('lookup', {query: {hostname: 'example.com'}});
    });
  });

  it('shows error for empty hostname', () => {
    const container = document.createElement('div');
    const ctx = fakeContext();

    createInstance(container, ctx);

    const btn = queryElement<HTMLButtonElement>(container, '.mndw-dns-lookup-widget__btn');

    btn.click();

    expect(container.textContent).toContain('Please enter a hostname');
  });

  it('shows unavailable when no backend', () => {
    const container = document.createElement('div');
    const ctx = fakeContext();

    ctx.backend = undefined;
    createInstance(container, ctx);

    const input = queryElement<HTMLInputElement>(container, '.mndw-dns-lookup-widget__input');
    const btn = queryElement<HTMLButtonElement>(container, '.mndw-dns-lookup-widget__btn');

    input.value = 'example.com';
    btn.click();

    expect(container.textContent).toContain('no backend available');
  });

  it('shows result on successful lookup', async () => {
    const container = document.createElement('div');
    const ctx = fakeContext();
    const backend = ctx.backend;

    if (backend !== undefined) {
      backend.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          success: true,
          hostname: 'localhost',
          addresses: ['127.0.0.1', '::1'],
          durationMs: 1.5,
        })),
      );
    }

    createInstance(container, ctx);

    const input = queryElement<HTMLInputElement>(container, '.mndw-dns-lookup-widget__input');
    const btn = queryElement<HTMLButtonElement>(container, '.mndw-dns-lookup-widget__btn');

    input.value = 'localhost';
    btn.click();

    await vi.waitFor(() => {
      expect(container.textContent).toContain('127.0.0.1');
      expect(container.textContent).toContain('::1');
      expect(container.textContent).toContain('1.5 ms');
    });
  });

  it('shows not-found for NXDOMAIN response', async () => {
    const container = document.createElement('div');
    const ctx = fakeContext();
    const backend = ctx.backend;

    if (backend !== undefined) {
      backend.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          success: false,
          error: 'NXDOMAIN',
          message: 'hostname not found',
          hostname: 'nope.invalid',
        })),
      );
    }

    createInstance(container, ctx);

    const input = queryElement<HTMLInputElement>(container, '.mndw-dns-lookup-widget__input');
    const btn = queryElement<HTMLButtonElement>(container, '.mndw-dns-lookup-widget__btn');

    input.value = 'nope.invalid';
    btn.click();

    await vi.waitFor(() => {
      expect(container.textContent).toContain('not found');
    });
  });

  it('cleans up event listeners on unmount', () => {
    const container = document.createElement('div');
    const ctx = fakeContext();
    const instance = createInstance(container, ctx);

    instance.unmount();

    expect(() => instance.unmount()).not.toThrow();
  });

  it('updates controls and result surface without remounting', () => {
    const container = document.createElement('div');
    const i18n = createTestI18n({
      l10n: {probe: 'DNS English'},
      hostname: 'Hostname EN',
      lookup: 'Lookup EN',
      idle: 'Idle EN',
    });
    const ctx = fakeContext();

    ctx.i18n = i18n;
    createInstance(container, ctx);

    const input = queryElement<HTMLInputElement>(container, '.mndw-dns-lookup-widget__input');
    const button = queryElement<HTMLButtonElement>(container, '.mndw-dns-lookup-widget__btn');
    const result = queryElement<HTMLElement>(container, '.mndw-dns-lookup-widget__result');
    const probe = queryElement<HTMLElement>(container, '[data-testid="l10n-probe"]');

    expect(probe.textContent).toBe('DNS English');
    expect(result.textContent).toContain('Idle EN');
    i18n.setLocale('ru', {
      l10n: {probe: 'DNS русский'},
      hostname: 'Имя RU',
      lookup: 'Найти RU',
      idle: 'Простой RU',
    });

    expect(container.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe.textContent).toBe('DNS русский');
    expect(input.placeholder).toBe('Имя RU');
    expect(button.textContent).toBe('Найти RU');
    expect(container.querySelector('.mndw-dns-lookup-widget__result')).toBe(result);
    expect(result.textContent).toContain('Простой RU');
  });
});
