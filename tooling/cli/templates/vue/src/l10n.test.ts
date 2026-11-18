// @vitest-environment happy-dom

import {createApp, nextTick} from 'vue';
import type {BackendClient, PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it, vi} from 'vitest';
import App from './App.vue';
import {createInstance} from './index.js';

const contextFor = (i18n: ReturnType<typeof createTestI18n>): PluginContext =>
  createTestPluginContext({i18n, kind: 'page'}).context;

describe('generated Vue locale reactivity', () => {
  it('updates visible result without remounting', async () => {
    const en = {l10n: {title: 'Plugin title', button: 'Run English', result: 'English result', error: 'Error'}};
    const ru = {l10n: {title: 'Заголовок', button: 'Запустить', result: 'Русский результат', error: 'Ошибка'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const app = createApp(App, {ctx: contextFor(i18n)});
    app.mount(root);
    const title = root.querySelector('h2');
    const button = root.querySelector('mndw-button');
    const result = root.querySelector('.result');

    expect(title?.textContent).toBe(en.l10n.title);
    expect(root.firstElementChild?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(button?.textContent).toContain(en.l10n.button);
    expect(result?.textContent).toBe(en.l10n.result);
    i18n.setLocale('ru', ru);
    await nextTick();

    expect(title?.textContent).toBe(ru.l10n.title);
    expect(button?.textContent).toContain(ru.l10n.button);
    expect(result?.textContent).toBe(ru.l10n.result);
    app.unmount();
  });

  it('sets a translated host title for widgets without drawing an internal heading', () => {
    const en = {l10n: {title: 'Plugin title', button: 'Run', result: 'Result', error: 'Error'}};
    const ru = {l10n: {title: 'Заголовок', button: 'Запустить', result: 'Результат', error: 'Ошибка'}};
    const i18n = createTestI18n(en, 'en');
    const setTileTitle = vi.fn();
    const fixture = createTestPluginContext({i18n});
    const context = {...fixture.context, setTileTitle} as PluginContext;
    const root = document.createElement('div');
    const instance = createInstance(root, context);

    expect(setTileTitle).toHaveBeenLastCalledWith(en.l10n.title);
    expect(root.querySelector('h2')).toBeNull();
    expect(root.firstElementChild?.hasAttribute('aria-labelledby')).toBe(false);
    i18n.setLocale('ru', ru);

    expect(setTileTitle).toHaveBeenLastCalledWith(ru.l10n.title);
    instance.unmount();
    fixture.unmount();
  });

  it('calls the backend when the shared button is clicked', async () => {
    const call = vi.fn().mockResolvedValue({message: 'hello'});
    const i18n = createTestI18n({
      l10n: {title: 'Plugin title', button: 'Run', result: 'Backend response', error: 'Unavailable'},
    });
    const fixture = createTestPluginContext({i18n, backend: {call} as unknown as BackendClient});
    const root = document.createElement('div');
    const app = createApp(App, {ctx: fixture.context});
    app.mount(root);

    root.querySelector('mndw-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith('hello', {as: 'json'});
      expect(root.querySelector('.result')?.textContent).toBe('Backend response: hello');
    });

    app.unmount();
    fixture.unmount();
  });
});
