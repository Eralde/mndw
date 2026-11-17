// @vitest-environment happy-dom

import {flushSync, mount, unmount} from 'svelte';
import type {BackendClient, PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it, vi} from 'vitest';
import App from './App.svelte';

const contextFor = (i18n: ReturnType<typeof createTestI18n>): PluginContext => createTestPluginContext({i18n}).context;

describe('generated Svelte locale reactivity', () => {
  it('updates visible control and result without remounting', () => {
    const en = {l10n: {title: 'Plugin title', button: 'Run English', result: 'English result', error: 'Error'}};
    const ru = {l10n: {title: 'Заголовок', button: 'Запустить', result: 'Русский результат', error: 'Ошибка'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const component = mount(App, {target: root, props: {ctx: contextFor(i18n)}});
    flushSync();
    const title = root.querySelector('h2');
    const button = root.querySelector('mndw-button');
    const result = root.querySelector('.result');

    expect(title?.textContent).toBe(en.l10n.title);
    expect(button?.textContent).toContain(en.l10n.button);
    expect(result?.textContent).toBe(en.l10n.result);
    i18n.setLocale('ru', ru);
    flushSync();

    expect(title?.textContent).toBe(ru.l10n.title);
    expect(button?.textContent).toContain(ru.l10n.button);
    expect(result?.textContent).toBe(ru.l10n.result);
    unmount(component);
  });

  it('calls the backend when the shared button is clicked', async () => {
    const call = vi.fn().mockResolvedValue({message: 'hello'});
    const i18n = createTestI18n({
      l10n: {title: 'Plugin title', button: 'Run', result: 'Backend response', error: 'Unavailable'},
    });
    const fixture = createTestPluginContext({i18n, backend: {call} as unknown as BackendClient});
    const root = document.createElement('div');
    const component = mount(App, {target: root, props: {ctx: fixture.context}});
    flushSync();

    root.querySelector('mndw-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith('hello', {as: 'json'});
      expect(root.querySelector('.result')?.textContent).toBe('Backend response: hello');
    });

    unmount(component);
    fixture.unmount();
  });

  it('shows the localized fallback when no backend is configured', () => {
    const i18n = createTestI18n({l10n: {title: 'Plugin', button: 'Run', result: 'Result', error: 'Unavailable'}});
    const root = document.createElement('div');
    const component = mount(App, {target: root, props: {ctx: contextFor(i18n)}});
    flushSync();
    root.querySelector('mndw-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    expect(root.querySelector('.result')?.textContent).toBe('Unavailable');
    unmount(component);
  });
});
