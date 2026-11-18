// @vitest-environment happy-dom

import {createApp, h, nextTick, onMounted} from 'vue';
import {describe, expect, it} from 'vitest';
import {createTestI18n} from '../testing/i18n.js';
import {useTranslator} from './use-translator.js';

describe('useTranslator', () => {
  it('updates a mounted Vue component without remounting', async () => {
    const i18n = createTestI18n({message: 'Hello'}, 'en');
    const host = document.createElement('div');
    let renderCount = 0;
    const app = createApp({
      setup() {
        const translator = useTranslator(i18n);

        return () => {
          renderCount += 1;

          return h('span', translator.t('message'));
        };
      },
    });

    app.mount(host);
    await nextTick();

    const node = host.firstElementChild;

    expect(node?.textContent).toBe('Hello');
    expect(renderCount).toBe(1);
    i18n.setLocale('ru', {message: 'Привет'});
    await nextTick();

    expect(host.firstElementChild).toBe(node);
    expect(node?.textContent).toBe('Привет');
    expect(renderCount).toBe(2);
    app.unmount();
  });

  it('updates if locale changes after the first render but before subscription', async () => {
    const i18n = createTestI18n({message: 'Hello'}, 'en');
    const host = document.createElement('div');
    let renderCount = 0;
    const app = createApp({
      setup() {
        const translator = useTranslator(i18n);
        const ChangeLocaleOnMount = {
          setup() {
            onMounted(() => i18n.setLocale('ru', {message: 'Привет'}));

            return () => null;
          },
        };

        return () => {
          renderCount += 1;

          return h('span', [translator.t('message'), h(ChangeLocaleOnMount)]);
        };
      },
    });

    app.mount(host);
    await nextTick();

    expect(host.textContent).toBe('Привет');
    expect(renderCount).toBe(2);
    app.unmount();
  });
});
