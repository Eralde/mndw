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

describe('MndwColumnMenu', () => {
  const columns = [
    {id: 'ip', label: 'IP'},
    {id: 'mac', label: 'MAC'},
    {id: 'clients', label: 'Clients'},
  ];

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

  it('dismisses with restoreFocus on Escape and without on Tab', async () => {
    const menu = makeMenu(columns);

    await menu.updateComplete;

    const dismissListener = vi.fn();

    menu.addEventListener('mndwpaneldismiss', dismissListener);

    shadowQuery(menu, '[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));

    expect((dismissListener.mock.calls[0][0] as CustomEvent<{restoreFocus: boolean}>).detail.restoreFocus).toBe(true);

    shadowQuery(menu, '[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true}));

    expect((dismissListener.mock.calls[1][0] as CustomEvent<{restoreFocus: boolean}>).detail.restoreFocus).toBe(false);
  });
});
