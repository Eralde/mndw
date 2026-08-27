// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import ruCatalog from '../i18n/ru.json';
import {type DnsView, render} from './render.js';

function renderRoot(view: DnsView): HTMLDivElement {
  const root = document.createElement('div');

  render(root, view, createTestI18n(enCatalog));

  return root;
}

function renderView(view: DnsView): string {
  const root = renderRoot(view);

  return root.innerHTML;
}

describe('render', () => {
  it('renders idle state', () => {
    const root = renderRoot({state: 'idle'});

    expect(root.textContent).toContain('Enter a hostname');
    expect(root.querySelector('.mndw-dns-lookup-widget__idle')).not.toBeNull();
  });

  it('renders unavailable state', () => {
    const root = document.createElement('div');

    render(root, {state: 'unavailable'}, createTestI18n(enCatalog));

    expect(root.textContent).toContain('no backend available');
    expect(root.querySelector('.mndw-dns-lookup-widget__unavailable')).not.toBeNull();
  });

  it('renders loading state with hostname', () => {
    const root = document.createElement('div');

    render(root, {state: 'loading', hostname: 'example.com'}, createTestI18n(enCatalog));

    expect(root.textContent).toContain('Looking up example.com');
    expect(root.querySelector('.mndw-dns-lookup-widget__loading')).not.toBeNull();
  });

  it('renders error state from stable code', () => {
    const html = renderView({state: 'error', code: 'lookup-failed'});

    expect(html).toContain('Lookup failed');
    expect(html).toContain('mndw-alert mndw-alert--danger');
    expect(html).toContain('role="alert"');
  });

  it('renders not-found state', () => {
    const root = document.createElement('div');

    render(root, {state: 'not-found', hostname: 'nope.invalid'}, createTestI18n(enCatalog));

    expect(root.textContent).toContain('not found');
    expect(root.textContent).toContain('nope.invalid');
    expect(root.querySelector('.mndw-dns-lookup-widget__not-found')).not.toBeNull();
  });

  it('renders result with addresses', () => {
    const root = renderRoot({
      state: 'result',
      result: {hostname: 'localhost', addresses: ['127.0.0.1', '::1'], durationMs: 1.5},
    });

    expect(root.textContent).toContain('localhost');
    expect(root.textContent).toContain('1.5 ms');
    expect(root.textContent).toContain('127.0.0.1');
    expect(root.textContent).toContain('::1');
    expect(root.querySelector('.mndw-dns-lookup-widget__result-addresses')).not.toBeNull();
  });

  it('renders CNAME when different from hostname', () => {
    const html = renderView({
      state: 'result',
      result: {
        hostname: 'www.example.com',
        addresses: ['93.184.215.14'],
        cname: 'example.com.',
        durationMs: 42.0,
      },
    });

    expect(html).toContain('CNAME: example.com.');
  });

  it('omits CNAME when same from hostname', () => {
    const html = renderView({
      state: 'result',
      result: {
        hostname: 'localhost',
        addresses: ['127.0.0.1'],
        cname: 'localhost.',
        durationMs: 1.0,
      },
    });

    expect(html).not.toContain('CNAME:');
  });

  it('renders localized labels and accessible result name', () => {
    const root = document.createElement('div');
    const i18n = createTestI18n(ruCatalog);

    render(
      root,
      {
        state: 'result',
        result: {hostname: 'example.com', addresses: ['192.0.2.1'], durationMs: 1.5},
      },
      i18n,
    );

    expect(root.textContent).toContain('Время поиска');
    expect(root.textContent).toContain('мс');
    expect(root.textContent).toContain('Адреса');
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Результат поиска DNS');

    const cnameRoot = renderRoot({
      state: 'result',
      result: {hostname: 'www.example.com', addresses: ['192.0.2.1'], cname: 'example.com.', durationMs: 1.5},
    });

    expect(cnameRoot.textContent).toContain('CNAME: example.com.');
  });

  it('resolves error copy from stable code for active locale', () => {
    const root = document.createElement('div');
    const i18n = createTestI18n(enCatalog);
    const view = {state: 'error', code: 'lookup-failed'} as const;

    render(root, view, i18n);
    expect(root.textContent).toContain('Lookup failed');

    i18n.setLocale('ru', ruCatalog);
    render(root, view, i18n);

    expect(root.textContent).toContain('Не удалось выполнить поиск');
    expect(root.textContent).not.toContain('Lookup failed');
  });
});
