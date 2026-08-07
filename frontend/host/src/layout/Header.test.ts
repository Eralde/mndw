import {of} from 'rxjs';
import {mount, unmount} from 'svelte';
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

describe('Header logout', () => {
  afterEach(() => {
    events.length = 0;
    postForget.mockClear();
    logout.mockClear();
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
