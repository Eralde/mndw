// @vitest-environment happy-dom

import {flushSync, mount, unmount} from 'svelte';
import type {PluginContext} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {describe, expect, it} from 'vitest';
import App from './App.svelte';

const contextFor = (i18n: ReturnType<typeof createTestI18n>): PluginContext => ({
  i18n,
  hostInfo: {deviceName: 'Test Device'},
} as PluginContext);

describe('generated Svelte locale reactivity', () => {
  it('updates the same probe node without remounting', () => {
    const en = {l10n: {probe: 'English probe', button: 'Run English', result: 'English result'}};
    const ru = {l10n: {probe: 'Русский probe', button: 'Запустить', result: 'Русский результат'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const component = mount(App, {target: root, props: {ctx: contextFor(i18n)}});
    flushSync();
    const probe = root.querySelector('[data-testid="l10n-probe"]');

    expect(en.l10n.probe).not.toBe(ru.l10n.probe);
    expect(probe?.textContent).toBe(en.l10n.probe);
    i18n.setLocale('ru', ru);
    flushSync();

    expect(root.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe(ru.l10n.probe);
    unmount(component);
  });
});
