// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient, PluginI18n} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import ruCatalog from '../i18n/ru.json';
import TerminalPage from './TerminalPage.svelte';

afterEach(() => vi.restoreAllMocks());

function notInstalledBackend(): {backend: BackendClient; fetch: ReturnType<typeof vi.fn>} {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({success: false, error: 'TTYD_NOT_INSTALLED', message: 'ttyd is not installed'}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    }),
  );

  return {backend: {fetch, socket: vi.fn()} as unknown as BackendClient, fetch};
}

function clickButton(host: HTMLElement, label: RegExp): void {
  const button = [...host.querySelectorAll('mndw-button')].find((b) => label.test(b.textContent ?? ''));

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  button.click();
}

function changingI18n(): {i18n: PluginI18n; setLocale(locale: 'en' | 'ru'): void} {
  const messages = {
    en: {'action.router-cli': 'Router CLI', 'action.entware-shell': 'Entware Shell',
      'l10n': {probe: 'Terminal English'}},
    ru: {'action.router-cli': 'CLI роутера', 'action.entware-shell': 'Оболочка Entware',
      'l10n': {probe: 'Терминал русский'}},
  };
  const i18n = createTestI18n(messages.en);

  return {
    i18n,
    setLocale: (nextLocale) => {
      i18n.setLocale(nextLocale, messages[nextLocale]);
    },
  };
}

describe('TerminalPage (dev path)', () => {
  it('renders both console buttons on the idle screen', () => {
    const {backend} = notInstalledBackend();
    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TerminalPage, {target: host, props: {backend, i18n: createTestI18n(enCatalog)}});

    flushSync();

    const labels = [...host.querySelectorAll('mndw-button')].map((b) => b.textContent ?? '');

    expect(labels.some((t) => /router cli/i.test(t))).toBe(true);
    expect(labels.some((t) => /entware shell/i.test(t))).toBe(true);

    void unmount(app);
    host.remove();
  });

  it('updates console buttons when locale changes', () => {
    const {backend} = notInstalledBackend();
    const changing = changingI18n();
    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TerminalPage, {target: host, props: {backend, i18n: changing.i18n}});

    flushSync();
    expect(host.textContent).toContain('Router CLI');

    const probe = host.querySelector<HTMLElement>('[data-testid="l10n-probe"]');

    expect(probe).not.toBeNull();
    expect(probe?.hidden).toBe(true);

    const enValue = probe?.textContent;

    expect(enValue).toBe('Terminal English');

    changing.setLocale('ru');
    flushSync();

    expect(host.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(enValue).not.toBe('Терминал русский');
    expect(probe?.textContent).toBe('Терминал русский');
    expect(host.textContent).toContain('CLI роутера');

    void unmount(app);
    host.remove();
  });

  it('sends the router console when Router CLI is clicked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const {backend, fetch} = notInstalledBackend();
    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TerminalPage, {target: host, props: {backend, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /router cli/i);

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('spawn', expect.objectContaining({body: {console: 'router'}}))
    );

    void unmount(app);
    host.remove();
  });

  it('renders localized ttyd installation guidance and the copyable command', async () => {
    const {backend} = notInstalledBackend();
    const i18n = createTestI18n(enCatalog);
    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TerminalPage, {target: host, props: {backend, i18n}});

    flushSync();
    clickButton(host, /router cli/i);

    await vi.waitFor(() =>
      expect(host.textContent ?? '').toContain(
        'The terminal needs the ttyd package, which is not installed. Install it on the router:',
      )
    );
    expect(host.querySelector('code')?.textContent).toBe('opkg install ttyd');

    i18n.setLocale('ru', ruCatalog);
    await vi.waitFor(() =>
      expect(host.textContent ?? '').toContain(
        'Для терминала нужен пакет ttyd, а он не установлен. Установите его на роутере:',
      )
    );
    expect(host.querySelector('code')?.textContent).toBe('opkg install ttyd');

    void unmount(app);
    host.remove();
  });

  it('reuses the selected console when Retry is clicked after a spawn error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const {backend, fetch} = notInstalledBackend();
    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TerminalPage, {target: host, props: {backend, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /entware shell/i);

    await vi.waitFor(() => expect(host.textContent ?? '').toMatch(/not installed/i));
    expect(host.querySelector('code')?.textContent).toBe('opkg install ttyd');
    clickButton(host, /retry/i);
    await vi.waitFor(() => expect(fetch.mock.calls.filter((c) => c[0] === 'spawn').length).toBe(2));

    for (const call of fetch.mock.calls.filter((c) => c[0] === 'spawn')) {
      expect(call[1]).toEqual(expect.objectContaining({body: {console: 'entware'}}));
    }

    void unmount(app);
    host.remove();
  });
});
