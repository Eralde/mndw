// @vitest-environment happy-dom

import {flushSync, mount, unmount} from 'svelte';
import type {PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it} from 'vitest';
import App from './App.svelte';

const contextFor = (i18n: ReturnType<typeof createTestI18n>): PluginContext => createTestPluginContext({i18n}).context;

describe('generated Svelte locale reactivity', () => {
  it('updates visible control and result without remounting', () => {
    const en = {l10n: {button: 'Run English', result: 'English result'}};
    const ru = {l10n: {button: 'Запустить', result: 'Русский результат'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const component = mount(App, {target: root, props: {ctx: contextFor(i18n)}});
    flushSync();
    const button = root.querySelector('button');
    const result = root.querySelector('.result');

    expect(button?.textContent).toContain(en.l10n.button);
    expect(result?.textContent).toBe(en.l10n.result);
    i18n.setLocale('ru', ru);
    flushSync();

    expect(button?.textContent).toContain(ru.l10n.button);
    expect(result?.textContent).toBe(ru.l10n.result);
    unmount(component);
  });

  it('updates data-theme when the host theme changes', () => {
    const fixture = createTestPluginContext();
    const root = document.createElement('div');
    const component = mount(App, {target: root, props: {ctx: fixture.context}});
    flushSync();

    expect(root.querySelector('.wrap')?.getAttribute('data-theme')).toBe('light');
    fixture.setTheme('dark');
    flushSync();
    expect(root.querySelector('.wrap')?.getAttribute('data-theme')).toBe('dark');

    unmount(component);
    fixture.unmount();
  });
});
