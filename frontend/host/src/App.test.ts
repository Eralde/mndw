import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import App from './App.svelte';
import {uiOverlayService} from './services/overlay/ui-overlay.js';
import {resetOverlayStateForTests} from './services/overlay/overlay-manager.svelte.js';
import {appState} from './state/app.svelte.js';

type MndwSelectElement = HTMLElement & {
  open: boolean;
  updateComplete: Promise<unknown>;
};

let target: HTMLDivElement;
let component: ReturnType<typeof mount>;

function render(): void {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(App, {target});
  flushSync();
}

function loginLocaleSelect(): MndwSelectElement {
  const select = target.querySelector<MndwSelectElement>('.mndw-login__locale-select');

  if (!select) {
    throw new Error('Login locale selector was not rendered');
  }

  return select;
}

function renderedSelectPanel(): Element | null {
  return document.querySelector('mndw-select-panel');
}

beforeAll(() => {
  defineMndwUi({overlay: uiOverlayService, initialLocale: 'en'});
});

beforeEach(() => {
  appState.authenticated = false;
  appState.ready = false;
  appState.locale = 'en';
  appState.localeSwitchPending = false;
  resetOverlayStateForTests();
});

afterEach(() => {
  uiOverlayService.closeAll();
  void unmount(component);
  resetOverlayStateForTests();
  document.body.innerHTML = '';
});

describe('App login overlays', () => {
  it('renders the login language options after a mouse click', async () => {
    render();

    const select = loginLocaleSelect();

    await select.updateComplete;

    select.dispatchEvent(new MouseEvent('click', {bubbles: true, composed: true}));
    flushSync();

    expect(select.open).toBe(true);
    expect(renderedSelectPanel()).not.toBeNull();
  });

  it('renders the login language options after keyboard activation', async () => {
    render();

    const select = loginLocaleSelect();

    await select.updateComplete;

    select.focus();
    select.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        composed: true,
      }),
    );
    flushSync();

    expect(select.open).toBe(true);
    expect(renderedSelectPanel()).not.toBeNull();
  });
});
