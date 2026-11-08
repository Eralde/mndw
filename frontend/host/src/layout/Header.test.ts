// @vitest-environment happy-dom
import {of} from 'rxjs';
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const {events, logout} = vi.hoisted(() => {
  const eventLog: string[] = [];
  const logoutMock = vi.fn(() => {
    eventLog.push('logout-start');

    return of(undefined);
  });

  return {events: eventLog, logout: logoutMock};
});

vi.mock('../services/rci.service.js', () => ({
  rciService: {logout},
}));

import Header from './Header.svelte';
import * as localeService from '../services/locale.service.js';
import {appState} from '../state/app.svelte.js';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

function restoreMatchMedia(): void {
  if (originalMatchMedia === undefined) {
    Reflect.deleteProperty(window, 'matchMedia');
  } else {
    Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  }
}

beforeAll(() => {
  defineMndwUi();
});

afterEach(() => {
  events.length = 0;
  logout.mockClear();
  appState.locale = 'en';
  appState.localeSwitchPending = false;
  appState.mobileSidebarOpen = false;
  appState.desktopSidebarCollapsed = false;

  restoreMatchMedia();

  vi.restoreAllMocks();
});

describe('Header locale controls', () => {
  it('offers one language selector with EN and RU options', () => {
    const setLocale = vi.fn().mockResolvedValue(undefined);
    const services = createHostServices();
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {
      target,
      context: createHostServicesContext({...services, locale: {...services.locale, setLocale}}),
    });
    const select = target.querySelector<HTMLElement & {value: string}>('.mndw-header__locale-select');
    const options = [...target.querySelectorAll('mndw-option')];

    expect(select).not.toBeNull();
    expect(select?.value).toBe('en');
    expect(options.map((option) => option.textContent?.trim())).toEqual(['EN', 'RU']);

    select?.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        detail: {value: 'ru'},
      }),
    );
    expect(setLocale).toHaveBeenCalledWith('ru');
    void unmount(component);
  });

  it('keeps language selector focus through an atomic locale switch', async () => {
    const switchControl: {finish?: () => void} = {};
    const switching = new Promise<void>((resolve) => {
      switchControl.finish = resolve;
    });
    const setLocale = vi.fn(async (locale: string): Promise<void> => {
      appState.localeSwitchPending = true;
      flushSync();
      await switching;
      appState.locale = locale;
      appState.localeSwitchPending = false;
      flushSync();
    });
    const services = createHostServices();
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {
      target,
      context: createHostServicesContext({...services, locale: {...services.locale, setLocale}}),
    });
    const select = target.querySelector<HTMLElement & {disabled: boolean; updateComplete: Promise<unknown>}>(
      '.mndw-header__locale-select',
    );

    expect(select).not.toBeNull();
    await select?.updateComplete;
    select?.focus();
    select?.dispatchEvent(
      new CustomEvent('mndwchange', {bubbles: true, detail: {value: 'ru'}}),
    );
    flushSync();

    expect(select?.disabled).toBe(false);
    expect(select?.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(select);

    switchControl.finish?.();
    await setLocale.mock.results[0]?.value;
    flushSync();

    expect(select?.disabled).toBe(false);
    expect(select?.getAttribute('aria-busy')).toBe('false');
    expect(document.activeElement).toBe(select);

    void unmount(component);
  });

  it('updates translated header labels after a locale commit', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target, context: createHostServicesContext(createHostServices())});

    try {
      expect(target.querySelector('.mndw-header__logout')?.textContent?.trim()).toBe('Logout');

      await localeService.localeService.setLocale('ru');
      flushSync();

      expect(target.querySelector('.mndw-header__logout')?.textContent?.trim()).toBe('Выйти');
      expect(target.querySelector<HTMLElement & {value: string}>('.mndw-header__locale-select')?.value).toBe('ru');
    } finally {
      await unmount(component);
      await localeService.localeService.setLocale('en');
    }
  });

  it('renders the theme toggle as an icon matching the target theme', async () => {
    const originalTheme = appState.theme;
    const target = document.createElement('div');

    document.body.appendChild(target);
    appState.theme = 'dark';

    const component = mount(Header, {target, context: createHostServicesContext(createHostServices())});
    const toggle = target.querySelector('.mndw-header__theme-toggle');

    try {
      await Promise.resolve();
      expect(toggle?.querySelector('mndw-icon')?.getAttribute('name')).toBe('sun');
      expect(toggle?.textContent?.trim()).toBe('');

      appState.theme = 'light';
      flushSync();
      await Promise.resolve();
      expect(toggle?.querySelector('mndw-icon')?.getAttribute('name')).toBe('moon');
    } finally {
      await unmount(component);
      appState.theme = originalTheme;
    }
  });

  it('renders logout as a ghost button with an icon and its label', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target, context: createHostServicesContext(createHostServices())});
    const logoutButton = target.querySelector('.mndw-header__logout');

    try {
      await Promise.resolve();
      expect(logoutButton?.getAttribute('variant')).toBe('ghost');
      expect(logoutButton?.querySelector('mndw-icon')?.getAttribute('name')).toBe('log-out');
      expect(logoutButton?.textContent?.trim()).toBe('Logout');
    } finally {
      await unmount(component);
    }
  });
});

describe('Header logout', () => {
  it('logs out of the router', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target, context: createHostServicesContext(createHostServices())});

    target.querySelector('.mndw-header__logout')?.dispatchEvent(new Event('click', {bubbles: true}));
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));

    expect(events).toEqual(['logout-start']);
    void unmount(component);
  });
});

describe('Header menu toggle', () => {
  it('toggles breakpoint-specific sidebar intent from the menu control', async () => {
    const matchMedia = vi.fn(() => ({matches: true}));

    vi.stubGlobal('matchMedia', matchMedia);
    Object.defineProperty(window, 'matchMedia', {configurable: true, value: matchMedia});

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target, context: createHostServicesContext(createHostServices())});
    const menu = target.querySelector<HTMLElement>('.mndw-header__menu-toggle');

    menu?.click();
    expect(appState.mobileSidebarOpen).toBe(true);
    expect(appState.desktopSidebarCollapsed).toBe(false);

    matchMedia.mockReturnValue({matches: false});
    menu?.click();

    expect(appState.mobileSidebarOpen).toBe(true);
    expect(appState.desktopSidebarCollapsed).toBe(true);
    await unmount(component);
  });
});
