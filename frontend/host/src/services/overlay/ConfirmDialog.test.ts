// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {createTestLocaleController} from '../../testing/test-locale.js';
import ConfirmDialog from './ConfirmDialog.svelte';

const {setLocale} = createTestLocaleController();

let component: ReturnType<typeof mount> | undefined;

describe('ConfirmDialog', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  afterEach(async () => {
    if (component !== undefined) {
      await unmount(component);
      component = undefined;
    }

    document.body.innerHTML = '';
    await setLocale('en');
  });

  it('localizes default labels and puts Cancel before Confirm', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);
    component = mount(ConfirmDialog, {target, props: {close: vi.fn(), danger: false}});
    flushSync();

    const buttons = [...target.querySelectorAll('mndw-button')];

    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Cancel', 'Confirm']);
    expect((buttons[0] as HTMLElement & {variant?: string}).variant).toBe('secondary');
    expect((buttons[1] as HTMLElement & {variant?: string}).variant).toBe('primary');
    expect(buttons[1]?.hasAttribute('data-overlay-initial-focus')).toBe(true);

    await setLocale('ru');
    flushSync();

    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Отмена', 'Подтвердить']);
  });

  it('uses a danger confirm button and focuses Cancel first', () => {
    const target = document.createElement('div');

    document.body.appendChild(target);
    component = mount(ConfirmDialog, {
      target,
      props: {close: vi.fn(), danger: true, confirmLabel: 'Delete'},
    });
    flushSync();

    const buttons = [...target.querySelectorAll('mndw-button')];

    expect(buttons[0]?.hasAttribute('data-overlay-initial-focus')).toBe(true);
    expect((buttons[1] as HTMLElement & {variant?: string}).variant).toBe('danger');
    expect(buttons[1]?.textContent?.trim()).toBe('Delete');
  });

  it('returns distinct answers from Cancel and Confirm', () => {
    const close = vi.fn();
    const target = document.createElement('div');

    document.body.appendChild(target);
    component = mount(ConfirmDialog, {target, props: {close, danger: false}});
    flushSync();

    target.querySelectorAll('mndw-button')[0]?.click();
    target.querySelectorAll('mndw-button')[1]?.click();

    expect(close.mock.calls).toEqual([[false], [true]]);
  });
});
