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

beforeAll(() => {
  defineMndwUi();
});

describe('Header logout', () => {
  afterEach(() => {
    events.length = 0;
    logout.mockClear();
    appState.locale = 'en';
    appState.localeSwitchPending = false;
    vi.restoreAllMocks();
  });

  it('offers one language selector with EN and RU options', () => {
    const setLocale = vi.spyOn(localeService, 'setLocale').mockResolvedValue();
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target});
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

  it('disables language controls during an atomic locale switch', () => {
    appState.localeSwitchPending = true;

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target});

    expect(target.querySelector<HTMLElement & {disabled: boolean}>('.mndw-header__locale-select')?.disabled).toBe(true);

    void unmount(component);
  });

  it('updates translated header labels after a locale commit', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target});

    try {
      expect(target.querySelector('.mndw-header__logout')?.textContent?.trim()).toBe('Logout');

      await localeService.setLocale('ru');
      flushSync();

      expect(target.querySelector('.mndw-header__logout')?.textContent?.trim()).toBe('Выйти');
      expect(target.querySelector<HTMLElement & {value: string}>('.mndw-header__locale-select')?.value).toBe('ru');
    } finally {
      await unmount(component);
      await localeService.setLocale('en');
    }
  });

  it('logs out of the router', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target});

    target.querySelector('.mndw-header__logout')?.dispatchEvent(new Event('click', {bubbles: true}));
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));

    expect(events).toEqual(['logout-start']);
    void unmount(component);
  });
});
