// @vitest-environment happy-dom
import {shadowOf, shadowQuery} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {defineComponents} from '../testing/index.js';
import {
  MNDW_COLUMN_MENU_CHECK_EVENT,
  MNDW_COLUMN_MENU_TAG,
  MndwColumnMenu,
  type MndwColumnMenuCheckDetail,
} from './column-menu.js';

defineComponents([MNDW_COLUMN_MENU_TAG, MndwColumnMenu]);

afterEach(() => {
  document.body.innerHTML = '';
});

function makeMenu(columns: {id: string; label: string}[], hidden: string[] = []): MndwColumnMenu {
  const menu = document.createElement(MNDW_COLUMN_MENU_TAG);

  menu.columns = columns;
  menu.hiddenColumns = hidden;
  document.body.appendChild(menu);

  return menu;
}

const columns = [
  {id: 'ip', label: 'IP'},
  {id: 'mac', label: 'MAC'},
  {id: 'clients', label: 'Clients'},
];

describe('MndwColumnMenu', () => {
  it('renders a menu of menuitemcheckbox options with checked state', async () => {
    const menu = makeMenu(columns, ['mac']);

    await menu.updateComplete;

    const shadow = shadowOf(menu);
    const menuRoot = shadow.querySelector('[role="menu"]');

    expect(menuRoot).not.toBeNull();

    const options = shadow.querySelectorAll('[role="menuitemcheckbox"]');

    expect(options).toHaveLength(3);
    expect(options[0].getAttribute('aria-checked')).toBe('true');
    expect(options[1].getAttribute('aria-checked')).toBe('false');
  });

  it('focuses the first item on open', async () => {
    const menu = makeMenu(columns);

    await menu.updateComplete;

    expect(shadowOf(menu).activeElement).toBe(shadowOf(menu).querySelector('button[data-column-id="ip"]'));
  });
});

describe('MndwColumnMenu interaction', () => {
  it('emits a single user-intent hidden list on toggle', async () => {
    const menu = makeMenu(columns, ['mac']);

    await menu.updateComplete;

    const checkListener = vi.fn();

    menu.addEventListener(MNDW_COLUMN_MENU_CHECK_EVENT, checkListener);

    shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="ip"]').click();
    shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="mac"]').click();

    expect(checkListener).toHaveBeenCalledTimes(2);
    expect((checkListener.mock.calls[0][0] as CustomEvent<MndwColumnMenuCheckDetail>).detail.hidden).toEqual([
      'mac',
      'ip',
    ]);
    expect((checkListener.mock.calls[1][0] as CustomEvent<MndwColumnMenuCheckDetail>).detail.hidden).toEqual(['ip']);
  });

  it('wraps arrow-key focus', async () => {
    const menu = makeMenu(columns);

    await menu.updateComplete;

    shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="ip"]').dispatchEvent(
      new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true}),
    );

    expect(shadowOf(menu).activeElement).toBe(shadowOf(menu).querySelector('button[data-column-id="clients"]'));
  });

  it('supports Home, End, and typeahead navigation', async () => {
    const menu = makeMenu(columns);

    await menu.updateComplete;

    shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="ip"]').dispatchEvent(
      new KeyboardEvent('keydown', {key: 'End', bubbles: true}),
    );
    expect(shadowOf(menu).activeElement).toBe(shadowOf(menu).querySelector('button[data-column-id="clients"]'));

    shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="clients"]').dispatchEvent(
      new KeyboardEvent('keydown', {key: 'm', bubbles: true}),
    );
    expect(shadowOf(menu).activeElement).toBe(shadowOf(menu).querySelector('button[data-column-id="mac"]'));

    shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="mac"]').dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Home', bubbles: true}),
    );
    expect(shadowOf(menu).activeElement).toBe(shadowOf(menu).querySelector('button[data-column-id="ip"]'));
  });

  it('keeps the menu open when Space toggles the focused checkbox', async () => {
    const menu = makeMenu(columns);

    await menu.updateComplete;

    const option = shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="ip"]');

    option.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true, cancelable: true}));
    option.click();
    await menu.updateComplete;

    expect(option.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector(MNDW_COLUMN_MENU_TAG)).toBe(menu);
  });

  it('toggles and closes on Enter', async () => {
    const menu = makeMenu(columns);
    const dismissListener = vi.fn();

    menu.addEventListener('mndwpaneldismiss', dismissListener);
    await menu.updateComplete;
    shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="ip"]').dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}),
    );
    await menu.updateComplete;

    expect(shadowQuery(menu, 'button[data-column-id="ip"]').getAttribute('aria-checked')).toBe('false');
    expect((dismissListener.mock.calls[0][0] as CustomEvent<{restoreFocus: boolean}>).detail.restoreFocus).toBe(true);
  });

  it('dismisses with restoreFocus on Escape and lets Tab proceed', async () => {
    const menu = makeMenu(columns);

    await menu.updateComplete;

    const dismissListener = vi.fn();

    menu.addEventListener('mndwpaneldismiss', dismissListener);

    shadowQuery(menu, '[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));

    expect((dismissListener.mock.calls[0][0] as CustomEvent<{restoreFocus: boolean}>).detail.restoreFocus).toBe(true);

    const tab = new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true});

    shadowQuery(menu, '[role="menu"]').dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(false);
    expect(
      (dismissListener.mock.calls[1][0] as CustomEvent<{
        restoreFocus: boolean;
        defer?: boolean;
        tabDirection?: 'backward' | 'forward';
      }>).detail,
    ).toEqual({restoreFocus: false, defer: true, tabDirection: 'forward'});
  });
});

describe('MndwColumnMenu visual indicator', () => {
  it('renders and updates a visual indicator for every option', async () => {
    const menu = makeMenu([
      {id: 'ip', label: 'IP'},
      {id: 'mac', label: 'MAC'},
    ], ['mac']);

    await menu.updateComplete;

    const ipOption = shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="ip"]');
    const macOption = shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="mac"]');
    const ipIndicator = ipOption.querySelector<HTMLElement>('[part="indicator"]');
    const macIndicator = macOption.querySelector<HTMLElement>('[part="indicator"]');

    expect(ipOption.getAttribute('aria-checked')).toBe('true');
    expect(ipIndicator?.getAttribute('data-checked')).toBe('true');
    expect(ipIndicator?.querySelector('[part="checkmark"]')).not.toBeNull();
    expect(macOption.getAttribute('aria-checked')).toBe('false');
    expect(macIndicator?.getAttribute('data-checked')).toBe('false');
    expect(macIndicator?.querySelector('[part="checkmark"]')).toBeNull();

    macOption.click();
    await menu.updateComplete;

    const updatedMacOption = shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="mac"]');
    const updatedMacIndicator = updatedMacOption.querySelector<HTMLElement>('[part="indicator"]');

    expect(updatedMacOption.getAttribute('aria-checked')).toBe('true');
    expect(updatedMacIndicator?.getAttribute('data-checked')).toBe('true');
    expect(updatedMacIndicator?.querySelector('[part="checkmark"]')).not.toBeNull();
  });
});
