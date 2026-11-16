// @vitest-environment happy-dom

import type {PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it} from 'vitest';
import {createInstance} from './index.js';

const contextFor = (i18n: ReturnType<typeof createTestI18n>): PluginContext => createTestPluginContext({i18n}).context;

describe('generated vanilla locale reactivity', () => {
  it('updates visible control and result without remounting', () => {
    const en = {l10n: {button: 'Run English', result: 'English result'}};
    const ru = {l10n: {button: 'Запустить', result: 'Русский результат'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const instance = createInstance(root, contextFor(i18n));
    const button = root.querySelector('button');
    const result = root.querySelector('[data-testid="l10n-result"]');

    expect(button?.textContent).toBe(en.l10n.button);
    expect(result?.textContent).toBe(en.l10n.result);
    i18n.setLocale('ru', ru);

    expect(button?.textContent).toBe(ru.l10n.button);
    expect(result?.textContent).toBe(ru.l10n.result);
    instance.unmount();
  });

  it('updates data-theme when the host theme changes', () => {
    const fixture = createTestPluginContext();
    const root = document.createElement('div');
    const instance = createInstance(root, fixture.context);

    expect(root.dataset.theme).toBe('light');
    fixture.setTheme('dark');
    expect(root.dataset.theme).toBe('dark');

    instance.unmount();
    fixture.unmount();
  });
});
