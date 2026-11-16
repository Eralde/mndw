// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {setLocale} from '../../services/locale.service.js';
import ConfirmActionModal from './ConfirmActionModal.svelte';

let component: ReturnType<typeof mount> | undefined;

describe('ConfirmActionModal', () => {
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

  it('localizes the cancel button', async () => {
    await setLocale('en');

    const target = document.createElement('div');

    document.body.appendChild(target);
    component = mount(ConfirmActionModal, {
      target,
      props: {message: 'Confirm action?', confirmLabel: 'Confirm', close: () => undefined},
    });
    flushSync();

    const cancelButton = target.querySelector('.actions mndw-button');

    expect(cancelButton?.textContent?.trim()).toBe('Cancel');

    await setLocale('ru');
    flushSync();

    expect(cancelButton?.textContent?.trim()).toBe('Отмена');
  });
});
