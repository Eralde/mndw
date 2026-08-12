// @vitest-environment happy-dom

import {createApp, h, nextTick} from 'vue';
import {describe, expect, it} from 'vitest';
import {createTestI18n} from '../testing/i18n.js';
import {useTranslator} from './use-translator.js';

describe('useTranslator', () => {
  it('updates a mounted Vue component without remounting', async () => {
    const i18n = createTestI18n({message: 'Hello'}, 'en');
    const host = document.createElement('div');
    const app = createApp({
      setup() {
        const translator = useTranslator(i18n);

        return () => h('span', translator.t('message'));
      },
    });

    app.mount(host);
    const node = host.firstElementChild;

    expect(node?.textContent).toBe('Hello');
    i18n.setLocale('ru', {message: 'Привет'});
    await nextTick();

    expect(host.firstElementChild).toBe(node);
    expect(node?.textContent).toBe('Привет');
    app.unmount();
  });
});
