// @vitest-environment happy-dom
import {type BackendClient, type PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import type {MndwButton, MndwInput} from '@mndw/ui';
import {describe, expect, it, vi} from 'vitest';
import enCatalog from '../i18n/en.json';
import ruCatalog from '../i18n/ru.json';
import {createInstance} from './index.js';

function fakeContext(
  overrides?: Partial<BackendClient>,
  options: {backend?: boolean; i18n?: ReturnType<typeof createTestI18n>} = {},
): PluginContext {
  const fetch = vi.fn().mockResolvedValue(new Response('{"method":"GET"}'));

  return createTestPluginContext({
    backend: options.backend === false ? undefined : {fetch, socket: vi.fn(), ...overrides} as BackendClient,
    i18n: options.i18n ?? createTestI18n(enCatalog),
    theme: 'light',
    instanceId: 'test-id',
  }).context;
}

function queryElement<T extends Element>(container: Element, selector: string): T {
  const element = container.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

function submitForm(container: Element): void {
  const form = queryElement<HTMLFormElement>(container, 'form');

  form.dispatchEvent(new SubmitEvent('submit', {bubbles: true, cancelable: true}));
}

describe('createInstance', () => {
  it('renders idle view on mount', () => {
    const container = document.createElement('div');
    const ctx = fakeContext();
    const instance = createInstance(container, ctx);

    expect(container.querySelector('.mndw-dns-lookup-widget')).not.toBeNull();
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.textContent).toContain('Enter a hostname');
    expect(container.querySelector('mndw-input')).not.toBeNull();
    expect(container.querySelector('mndw-button')).not.toBeNull();
    expect(container.querySelector('.mndw-dns-lookup-widget__input')).not.toBeNull();
    expect(container.querySelector('.mndw-dns-lookup-widget__btn')).not.toBeNull();

    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');
    const button = queryElement<MndwButton>(container, '.mndw-dns-lookup-widget__btn');
    const controlRow = queryElement<HTMLElement>(container, '.mndw-dns-lookup-widget__control-row');

    const label = queryElement<HTMLLabelElement>(container, 'label[for="mndw-dns-lookup-widget__hostname"]');

    expect(label.htmlFor).toBe(input.id);
    expect(controlRow.contains(input)).toBe(true);
    expect(controlRow.contains(button)).toBe(true);
    expect(input.name).toBe('hostname');
    expect(input.type).toBe('text');
    expect(button.type).toBe('submit');
    expect(button.variant).toBe('primary');
    expect(input.getAttribute('aria-describedby')).toBe('mndw-dns-lookup-widget__hostname-hint');

    instance.unmount();
    expect(container.children.length).toBe(0);
  });

  it('shows loading state when lookup is clicked', async () => {
    const container = document.createElement('div');
    const ctx = fakeContext();
    const backend = ctx.backend;

    createInstance(container, ctx);

    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');

    input.value = 'example.com';

    submitForm(container);

    expect(container.textContent).toContain('Looking up example.com');
    expect(queryElement<HTMLElement>(container, '.mndw-dns-lookup-widget__result').getAttribute('aria-live')).toBe(
      'polite',
    );
    expect(queryElement<HTMLElement>(container, '.mndw-dns-lookup-widget__result').getAttribute('aria-busy')).toBe(
      'true',
    );

    await vi.waitFor(() => {
      const backendFetch = backend === undefined ? undefined : Reflect.get(backend, 'fetch');

      expect(backendFetch).toHaveBeenCalledWith('lookup', {query: {hostname: 'example.com'}});
    });
  });

  it('submits through the native form once', async () => {
    const container = document.createElement('div');
    const ctx = fakeContext();
    const backend = ctx.backend;

    createInstance(container, ctx);

    const form = queryElement<HTMLFormElement>(container, 'form');
    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');

    input.value = 'example.com';
    form.dispatchEvent(new SubmitEvent('submit', {bubbles: true, cancelable: true}));

    await vi.waitFor(() => {
      const backendFetch = backend === undefined ? undefined : Reflect.get(backend, 'fetch');

      expect(backendFetch).toHaveBeenCalledTimes(1);
    });
  });

  it('shows error for empty hostname', () => {
    const container = document.createElement('div');
    const ctx = fakeContext();

    createInstance(container, ctx);

    submitForm(container);

    expect(container.textContent).toContain('Please enter a hostname');
  });

  it('maps backend failures to localized generic copy without exposing details', async () => {
    const container = document.createElement('div');
    const ctx = fakeContext();

    if (ctx.backend !== undefined) {
      ctx.backend.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          success: false,
          error: 'LOOKUP_FAILED',
          message: 'lookup nope.invalid on 127.0.0.1:53: i/o timeout',
        })),
      );
    }

    createInstance(container, ctx);

    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');

    input.value = 'nope.invalid';

    submitForm(container);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Lookup failed');
      expect(container.textContent).not.toContain('LOOKUP_FAILED');
      expect(container.textContent).not.toContain('127.0.0.1:53');
      expect(input.disabled).toBe(false);
    });
  });

  it('maps unknown backend codes to the same localized generic copy', async () => {
    const container = document.createElement('div');
    const ctx = fakeContext();

    if (ctx.backend !== undefined) {
      ctx.backend.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          success: false,
          error: 'UNKNOWN_CODE',
          message: 'internal resolver details',
        })),
      );
    }

    createInstance(container, ctx);

    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');

    input.value = 'unknown.invalid';
    submitForm(container);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Lookup failed');
      expect(container.textContent).not.toContain('UNKNOWN_CODE');
      expect(container.textContent).not.toContain('internal resolver details');
    });
  });

  it('rerenders active error copy after locale changes', () => {
    const container = document.createElement('div');
    const ctx = fakeContext();

    createInstance(container, ctx);
    submitForm(container);

    expect(container.textContent).toContain('Please enter a hostname');

    ctx.i18n.setLocale('ru', ruCatalog);

    expect(container.textContent).toContain('Введите имя хоста');
    expect(container.textContent).not.toContain('Please enter a hostname');
  });

  it('shows unavailable when no backend', () => {
    const container = document.createElement('div');
    const ctx = fakeContext(undefined, {backend: false});

    createInstance(container, ctx);

    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');

    input.value = 'example.com';

    submitForm(container);

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

    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');

    input.value = 'localhost';

    submitForm(container);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('127.0.0.1');
      expect(container.textContent).toContain('::1');
      expect(container.textContent).toContain('1.5 ms');
      expect(queryElement<HTMLElement>(container, '.mndw-dns-lookup-widget__result').getAttribute('aria-busy'))
        .toBeNull();
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

    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');

    input.value = 'nope.invalid';

    submitForm(container);

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
      'l10n': {probe: 'DNS English'},
      'hostname-label': 'Hostname label EN',
      'hostname-hint': 'Hostname hint EN',
      'hostname': 'Hostname EN',
      'lookup': 'Lookup EN',
      'idle': 'Idle EN',
    });
    const ctx = fakeContext(undefined, {i18n});

    createInstance(container, ctx);

    const input = queryElement<MndwInput>(container, '.mndw-dns-lookup-widget__input');
    const button = queryElement<MndwButton>(container, '.mndw-dns-lookup-widget__btn');
    const label = queryElement<HTMLLabelElement>(container, '.mndw-dns-lookup-widget__label');
    const hint = queryElement<HTMLElement>(container, '.mndw-dns-lookup-widget__hint');
    const result = queryElement<HTMLElement>(container, '.mndw-dns-lookup-widget__result');
    const probe = queryElement<HTMLElement>(container, '[data-testid="l10n-probe"]');

    expect(probe.textContent).toBe('DNS English');
    expect(label.textContent).toBe('Hostname label EN');
    expect(hint.textContent).toBe('Hostname hint EN');
    expect(result.textContent).toContain('Idle EN');
    i18n.setLocale('ru', {
      'l10n': {probe: 'DNS русский'},
      'hostname-label': 'Имя RU',
      'hostname-hint': 'Подсказка RU',
      'hostname': 'Имя RU',
      'lookup': 'Найти RU',
      'idle': 'Простой RU',
    });

    expect(container.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe.textContent).toBe('DNS русский');
    expect(input.placeholder).toBe('Имя RU');
    expect(label.textContent).toBe('Имя RU');
    expect(hint.textContent).toBe('Подсказка RU');
    expect(button.textContent).toBe('Найти RU');
    expect(container.querySelector('.mndw-dns-lookup-widget__result')).toBe(result);
    expect(result.textContent).toContain('Простой RU');
  });
});
