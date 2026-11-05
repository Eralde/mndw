// @vitest-environment happy-dom

import type {PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it} from 'vitest';
import {createInstance} from './index.js';

const contextFor = (i18n: ReturnType<typeof createTestI18n>): PluginContext => createTestPluginContext({i18n}).context;

describe('generated vanilla locale reactivity', () => {
  it('updates probe, control, and result without remounting', () => {
    const en = {l10n: {probe: 'English probe', button: 'Run English', result: 'English result'}};
    const ru = {l10n: {probe: 'Русский probe', button: 'Запустить', result: 'Русский результат'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const instance = createInstance(root, contextFor(i18n));
    const probe = root.querySelector('[data-testid="l10n-probe"]');
    const button = root.querySelector('button');
    const result = root.querySelector('[data-testid="l10n-result"]');

    expect(en.l10n.probe).not.toBe(ru.l10n.probe);
    expect(probe?.textContent).toBe(en.l10n.probe);
    i18n.setLocale('ru', ru);

    expect(root.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe(ru.l10n.probe);
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
