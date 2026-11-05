// @vitest-environment happy-dom

import {createApp, nextTick} from 'vue';
import type {PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it} from 'vitest';
import App from './App.vue';

const contextFor = (i18n: ReturnType<typeof createTestI18n>): PluginContext => createTestPluginContext({i18n}).context;

describe('generated Vue locale reactivity', () => {
  it('updates the same probe node without remounting', async () => {
    const en = {l10n: {probe: 'English probe', result: 'English result'}};
    const ru = {l10n: {probe: 'Русский probe', result: 'Русский результат'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const app = createApp(App, {ctx: contextFor(i18n)});
    app.mount(root);
    const probe = root.querySelector('[data-testid="l10n-probe"]');

    expect(en.l10n.probe).not.toBe(ru.l10n.probe);
    expect(probe?.textContent).toBe(en.l10n.probe);
    i18n.setLocale('ru', ru);
    await nextTick();

    expect(root.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe(ru.l10n.probe);
    app.unmount();
  });

  it('updates data-theme when the host theme changes', async () => {
    const fixture = createTestPluginContext();
    const root = document.createElement('div');
    const app = createApp(App, {ctx: fixture.context});
    app.mount(root);

    expect(root.querySelector('.wrap')?.getAttribute('data-theme')).toBe('light');
    fixture.setTheme('dark');
    await nextTick();
    expect(root.querySelector('.wrap')?.getAttribute('data-theme')).toBe('dark');

    app.unmount();
    fixture.unmount();
  });
});
