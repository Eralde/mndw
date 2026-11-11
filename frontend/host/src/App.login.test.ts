// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {type Observable, of} from 'rxjs';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const login = vi.fn<(user: string, password: string) => Observable<boolean>>();
const initAuthenticated = vi.fn<() => Promise<unknown>>();

vi.mock('./services/rci.service.js', () => ({
  rciService: {
    login: (user: string, password: string) => login(user, password),
  },
}));
vi.mock('./services/init-auth.js', () => ({
  initAuthenticated: (): Promise<unknown> => initAuthenticated(),
}));

import App from './App.svelte';
import {createHostServices} from './host-services.js';
import {uiOverlayService} from './services/overlay/ui-overlay.js';
import {appState, resetToLogin} from './state/app.svelte.js';

type LoginInput = HTMLElement & {
  value: string;
  disabled: boolean;
  updateComplete: Promise<unknown>;
};

let target: HTMLDivElement;
let component: ReturnType<typeof mount>;

function render(): void {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(App, {target, props: {services: createHostServices()}});
  flushSync();
}

function inputs(): LoginInput[] {
  return [...target.querySelectorAll<LoginInput>('mndw-input')];
}

function type(element: HTMLElement, value: string): void {
  element.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value}}));
  flushSync();
}

function submit(): void {
  target.querySelector('form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
  flushSync();
}

function pressEnter(element: HTMLElement): void {
  element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
  flushSync();
}

beforeAll(() => {
  defineMndwUi({overlay: uiOverlayService, initialLocale: 'en'});
});

beforeEach(() => {
  login.mockReset();
  initAuthenticated.mockReset();
  appState.authenticated = false;
  appState.ready = false;
  appState.locale = 'en';
  appState.localeSwitchPending = false;
  appState.loginError = null;
  appState.loginUsername = '';
});

afterEach(() => {
  uiOverlayService.closeAll();
  void unmount(component);
  document.body.innerHTML = '';
});

describe('App login', () => {
  it('shows the connection error with the kept username after authenticated initialization fails', async () => {
    login.mockReturnValue(of(true));
    initAuthenticated
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'secret');

    submit();

    // Accepting the credentials flips `authenticated`, so App unmounts this LoginPage and shows
    // its loading branch; the rejected initAuthenticated then returns to a *fresh* LoginPage.
    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-login')).not.toBeNull();
      expect(target.querySelector('.mndw-alert')?.textContent?.trim()).toBe('Connection failed');
    });

    const [username, password] = inputs();

    await username.updateComplete;
    expect(username.value).toBe('admin');
    expect(password.value).toBe('');

    // Nothing is stuck: the button enables as soon as the password is supplied again (the
    // button gates on both fields), and Enter resubmits the same credentials.
    type(password, 'secret');
    expect(target.querySelector('mndw-button')?.disabled).toBe(false);

    pressEnter(password);

    expect(login).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenNthCalledWith(2, 'admin', 'secret');
  });

  it('does not leak the failure into a fresh login page after resetting to login', async () => {
    appState.loginError = 'Connection failed';
    appState.loginUsername = 'admin';

    // Logout (and any other path back to login) goes through resetToLogin.
    resetToLogin();
    render();

    expect(target.querySelector('.mndw-alert')).toBeNull();
    expect(inputs()[0].value).toBe('');
  });
});
