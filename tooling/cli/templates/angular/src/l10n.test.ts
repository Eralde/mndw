// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import type {PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it} from 'vitest';
import {createInstance} from './index.js';

async function stabilize(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('generated Angular locale reactivity', () => {
  it('updates visible control and result without remounting', async () => {
    const en = {l10n: {button: 'Run English', result: 'English result'}};
    const ru = {l10n: {button: 'Запустить', result: 'Русский результат'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const context = createTestPluginContext({i18n}).context;
    const instance = createInstance(root, context);
    await stabilize();
    const button = root.querySelector('button');
    const result = root.querySelector('[data-testid="l10n-result"]');

    expect(button?.textContent).toContain(en.l10n.button);
    expect(result?.textContent).toBe(en.l10n.result);
    i18n.setLocale('ru', ru);
    await stabilize();

    expect(button?.textContent).toContain(ru.l10n.button);
    expect(result?.textContent).toBe(ru.l10n.result);
    instance.unmount();
  });

  it('updates data-theme when the host theme changes', async () => {
    const fixture = createTestPluginContext();
    const root = document.createElement('div');
    const instance = createInstance(root, fixture.context);
    await stabilize();

    expect(root.querySelector('[data-theme]')?.getAttribute('data-theme')).toBe('light');
    fixture.setTheme('dark');
    await stabilize();
    expect(root.querySelector('[data-theme]')?.getAttribute('data-theme')).toBe('dark');

    instance.unmount();
    fixture.unmount();
  });
});
