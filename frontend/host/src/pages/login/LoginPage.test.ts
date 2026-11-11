// @vitest-environment happy-dom
import {deepActiveElement, defineMndwUi} from '@mndw/ui';
import {type Observable, Subject, of, throwError} from 'rxjs';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const login = vi.fn<(user: string, password: string) => Observable<boolean>>();
const initAuthenticated = vi.fn<() => Promise<void>>();

vi.mock('../../services/rci.service.js', () => ({
  rciService: {
    login: (user: string, password: string) => login(user, password),
  },
}));
vi.mock('../../services/init-auth.js', () => ({
  initAuthenticated: (): Promise<void> => initAuthenticated(),
}));

import LoginPage from './LoginPage.svelte';
import {appState} from '../../state/app.svelte.js';
import {createHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';

type LoginInput = HTMLElement & {
  value: string;
  disabled: boolean;
  updateComplete: Promise<unknown>;
};

let target: HTMLDivElement;
let component: ReturnType<typeof mount>;

function render(context = createHostServicesContext(createHostServices())): void {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LoginPage, {target, context});
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

// The app defines the kit before mounting (`startup.ts`), which is what makes Svelte assign
// properties rather than attributes on these elements — so the test registers it too.
beforeAll(() => {
  defineMndwUi();
});

beforeEach(() => {
  login.mockReset();
  initAuthenticated.mockReset();
  initAuthenticated.mockResolvedValue(undefined);
  appState.authenticated = false;
  appState.locale = 'en';
  appState.localeSwitchPending = false;
  appState.loginError = null;
  appState.loginUsername = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  void unmount(component);
  document.body.innerHTML = '';
});

describe('LoginPage', () => {
  it('offers a language selector before authentication', () => {
    const setLocale = vi.fn().mockResolvedValue(undefined);
    const services = createHostServices();

    render(createHostServicesContext({...services, locale: {...services.locale, setLocale}}));

    const select = target.querySelector<HTMLElement & {value: string}>('.mndw-login__locale-select');
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
  });

  it('keeps the language selector focused while a locale loads', async () => {
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

    render(createHostServicesContext({...services, locale: {...services.locale, setLocale}}));

    const select = target.querySelector<HTMLElement & {disabled: boolean; updateComplete: Promise<unknown>}>(
      '.mndw-login__locale-select',
    );
    const username = inputs()[0];

    await Promise.all([select?.updateComplete, username.updateComplete]);
    await vi.waitFor(() => {
      expect(deepActiveElement()).toBe(username.shadowRoot?.querySelector('input'));
    });

    select?.focus();
    select?.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, detail: {value: 'ru'}}));
    flushSync();

    expect(select?.disabled).toBe(false);
    expect(select?.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(select);

    switchControl.finish?.();
    await setLocale.mock.results[0]?.value;
    flushSync();

    expect(select?.getAttribute('aria-busy')).toBe('false');
    expect(target.querySelector('.mndw-login')?.getAttribute('data-locale')).toBe('ru');
    expect(document.activeElement).toBe(select);
  });

  it('focuses the username input after it upgrades', async () => {
    render();

    const username = inputs()[0];

    await customElements.whenDefined('mndw-input');
    await username.updateComplete;

    const innerInput = username.shadowRoot?.querySelector('input');

    await vi.waitFor(() => {
      expect(deepActiveElement()).toBe(innerInput);
    });

    expect(deepActiveElement()).toBe(innerInput);
  });

  it('keeps focus on the language selector when it is focused before the input upgrades', async () => {
    const originalWhenDefined = customElements.whenDefined.bind(customElements);
    let finishInputUpgrade: (constructor: CustomElementConstructor) => void = () => {};
    const inputUpgrade = new Promise<CustomElementConstructor>((resolve) => {
      finishInputUpgrade = resolve;
    });

    vi.spyOn(customElements, 'whenDefined').mockImplementation((name) => {
      if (name === 'mndw-input') {
        return inputUpgrade;
      }

      return originalWhenDefined(name);
    });

    render();

    const select = target.querySelector<HTMLElement & {updateComplete: Promise<unknown>}>(
      '.mndw-login__locale-select',
    );
    const username = inputs()[0];
    const inputConstructor = customElements.get('mndw-input');

    await select?.updateComplete;
    select?.focus();
    expect(inputConstructor).toBeDefined();

    if (!inputConstructor) {
      throw new Error('mndw-input was not defined');
    }

    finishInputUpgrade(inputConstructor);
    await inputUpgrade;
    await username.updateComplete;

    expect(document.activeElement).toBe(select);
  });

  it('renders both credentials as kit text controls inside labelled fields', async () => {
    render();

    const fields = [...target.querySelectorAll<HTMLElement & {label: string; updateComplete: Promise<unknown>}>(
      'mndw-field',
    )];

    await Promise.all(fields.map(async (field) => field.updateComplete));

    // No native inputs of its own: the two credentials are `<mndw-input>` hosts now, and each
    // input's own `<input>` lives inside its shadow root. `label` is a property, not an attribute —
    // `<mndw-field>` does not reflect it — so the real check is the label element it renders.
    expect(target.querySelectorAll('input')).toHaveLength(0);
    expect(fields.map((field) => field.label)).toEqual(['Username', 'Password']);
    // `stringContaining`, because field's own required marker is a hidden node inside the label.
    expect([...target.querySelectorAll('label.mndw-field__label')].map((label) => label.textContent))
      .toEqual([expect.stringContaining('Username'), expect.stringContaining('Password')]);
    expect(inputs()).toHaveLength(2);
    expect(inputs()[1].getAttribute('type')).toBe('password');
    expect(inputs()[0].getAttribute('autocomplete')).toBe('username');
    expect(inputs()[1].getAttribute('autocomplete')).toBe('current-password');
  });

  it('points each field label at the control it names', async () => {
    render();

    const fields = [...target.querySelectorAll<HTMLElement & {updateComplete: Promise<unknown>}>('mndw-field')];

    await Promise.all(fields.map(async (field) => field.updateComplete));

    const labels = [...target.querySelectorAll<HTMLLabelElement>('label.mndw-field__label')];

    expect(labels).toHaveLength(2);

    for (const [index, label] of labels.entries()) {
      expect(label.htmlFor).not.toBe('');
      expect(label.htmlFor).toBe(inputs()[index].id);
    }
  });

  it('submits what the user typed', () => {
    login.mockReturnValue(of(true));
    render();

    type(inputs()[0], 'admin');
    type(inputs()[1], 'secret');
    submit();

    expect(login).toHaveBeenCalledWith('admin', 'secret');
  });

  it('submits on Enter only after both credentials are filled', () => {
    login.mockReturnValue(of(true));
    render();

    pressEnter(inputs()[0]);
    expect(login).not.toHaveBeenCalled();

    type(inputs()[0], 'admin');
    pressEnter(inputs()[0]);
    expect(login).not.toHaveBeenCalled();

    type(inputs()[1], 'secret');
    pressEnter(inputs()[1]);

    expect(login).toHaveBeenCalledWith('admin', 'secret');
  });

  it('authenticates and initialises on a successful login', () => {
    login.mockReturnValue(of(true));
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'secret');
    submit();

    expect(appState.authenticated).toBe(true);
    expect(initAuthenticated).toHaveBeenCalledWith();
  });

  it('announces rejected credentials as a danger alert without moving focus', async () => {
    login.mockReturnValue(of(false));
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'wrong');

    const password = inputs()[1];

    await password.updateComplete;
    password.focus();
    pressEnter(password);

    const alert = target.querySelector('.mndw-alert');

    expect(alert?.className).toBe('mndw-alert mndw-alert--danger');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent?.trim()).toBe('Invalid credentials');
    expect(target.querySelector('.mndw-login__error')).toBeNull();
    expect(target.querySelector('mndw-button')?.disabled).toBe(true);
    expect(appState.authenticated).toBe(false);
    expect(deepActiveElement()).toBe(password.shadowRoot?.querySelector('input'));
  });

  it('announces a transport failure the same way', () => {
    login.mockReturnValue(throwError(() => new Error('offline')));
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'secret');
    submit();

    expect(target.querySelector('.mndw-alert')?.textContent?.trim()).toBe('Connection failed');
  });

  it('retries a transport failure with unchanged credentials when Enter is pressed', () => {
    login
      .mockReturnValueOnce(throwError(() => new Error('offline')))
      .mockReturnValueOnce(of(true));
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'secret');

    pressEnter(inputs()[1]);

    expect(target.querySelector('.mndw-alert')?.textContent?.trim()).toBe('Connection failed');
    expect(target.querySelector('mndw-button')?.disabled).toBe(false);

    pressEnter(inputs()[1]);

    expect(login).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenNthCalledWith(2, 'admin', 'secret');
  });

  it('keeps the username and error in app state when authenticated initialization fails', async () => {
    login.mockReturnValue(of(true));
    initAuthenticated.mockRejectedValueOnce(new Error('offline'));
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'secret');

    submit();

    // The submitting instance is unmounted by the failure (App swaps to its loading branch on
    // success), so the retry affordances travel through appState for the next LoginPage mount.
    await vi.waitFor(() => {
      expect(appState.loginError).toBe('Connection failed');
    });
    expect(appState.loginUsername).toBe('admin');
    expect(appState.authenticated).toBe(false);
  });

  it('disables both controls and the button while the request is in flight', () => {
    const pending = new Subject<boolean>();

    login.mockReturnValue(pending.asObservable());
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'secret');
    submit();

    expect(inputs().every((control) => control.disabled)).toBe(true);
    expect(target.querySelector('mndw-button')?.disabled).toBe(true);
    expect(target.querySelector('mndw-button')?.textContent?.trim()).toBe('Logging in…');

    pending.next(false);
    flushSync();

    expect(inputs().some((control) => control.disabled)).toBe(false);
    expect(target.querySelector('mndw-button')?.textContent?.trim()).toBe('Login');
  });

  it('disables Login after failure and re-enables it when either input changes', () => {
    login.mockReturnValue(of(false));
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'wrong');
    submit();

    const button = target.querySelector('mndw-button');

    expect(button?.disabled).toBe(true);
    pressEnter(inputs()[1]);
    expect(login).toHaveBeenCalledTimes(1);

    type(inputs()[0], 'admin2');
    expect(button?.disabled).toBe(false);

    submit();
    expect(button?.disabled).toBe(true);

    type(inputs()[1], 'correct');
    expect(button?.disabled).toBe(false);
  });

  it('marks the Login button for extra spacing below the fields', () => {
    render();

    expect(target.querySelector('mndw-button')?.classList.contains('mndw-login__submit')).toBe(true);
  });

  it('clears a previous error when the form is resubmitted', () => {
    login.mockReturnValue(of(false));
    render();
    type(inputs()[0], 'admin');
    type(inputs()[1], 'wrong');
    submit();

    expect(target.querySelector('.mndw-alert')).not.toBeNull();

    const pending = new Subject<boolean>();

    login.mockReturnValue(pending.asObservable());
    type(inputs()[0], 'admin2');
    submit();

    expect(target.querySelector('.mndw-alert')).toBeNull();
  });
});
