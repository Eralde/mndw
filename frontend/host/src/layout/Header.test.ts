import {of} from 'rxjs';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';

const {events, postForget, logout} = vi.hoisted(() => {
  const eventLog: string[] = [];
  const postForgetMock = vi.fn(() => {
    eventLog.push('forget');

    return Promise.resolve();
  });
  const logoutMock = vi.fn(() => {
    eventLog.push('logout-start');

    return of(undefined);
  });

  return {events: eventLog, postForget: postForgetMock, logout: logoutMock};
});

vi.mock('../services/extender-access.service.js', () => ({
  extenderAccessService: {postForget},
}));
vi.mock('../services/rci.service.js', () => ({
  rciService: {logout},
}));

import Header from './Header.svelte';
import * as localeService from '../services/locale.service.js';
import {appState} from '../state/app.svelte.js';

describe('Header logout', () => {
  afterEach(() => {
    events.length = 0;
    postForget.mockClear();
    logout.mockClear();
    appState.locale = 'en';
    appState.localeSwitchPending = false;
    vi.restoreAllMocks();
  });

  it('offers EN and RU controls and requests the selected locale', () => {
    const setLocale = vi.spyOn(localeService, 'setLocale').mockResolvedValue();
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target});
    const buttons = [...target.querySelectorAll('.mndw-header__locale-button')];

    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['EN', 'RU']);

    buttons[1]?.dispatchEvent(new Event('click', {bubbles: true}));
    expect(setLocale).toHaveBeenCalledWith('ru');
    void unmount(component);
  });

  it('disables language controls during an atomic locale switch', () => {
    appState.localeSwitchPending = true;

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target});

    expect(
      [...target.querySelectorAll('.mndw-header__locale-button')].every((button) => button.hasAttribute('disabled')),
    )
      .toBe(true);

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
    } finally {
      await unmount(component);
      await localeService.setLocale('en');
    }
  });

  it('forgets extender credentials before logging out of the router', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(Header, {target});

    target.querySelector('.mndw-header__logout')?.dispatchEvent(new Event('click', {bubbles: true}));
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));

    expect(events).toEqual(['forget', 'logout-start']);
    void unmount(component);
  });
});
