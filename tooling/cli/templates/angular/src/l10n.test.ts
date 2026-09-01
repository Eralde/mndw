// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import type {PluginContext} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {describe, expect, it} from 'vitest';
import {createInstance} from './index.js';

async function stabilize(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('generated Angular locale reactivity', () => {
  it('updates the same probe node without remounting', async () => {
    const en = {l10n: {probe: 'English probe', button: 'Run English', result: 'English result'}};
    const ru = {l10n: {probe: 'Русский probe', button: 'Запустить', result: 'Русский результат'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const context = {i18n, hostInfo: {locale: 'en', theme: 'dark'},
      deviceInfo: {deviceName: 'Test Device'}} as unknown as PluginContext;
    const instance = createInstance(root, context);
    await stabilize();
    const probe = root.querySelector('[data-testid="l10n-probe"]');

    expect(en.l10n.probe).not.toBe(ru.l10n.probe);
    expect(probe?.textContent).toBe(en.l10n.probe);
    i18n.setLocale('ru', ru);
    await stabilize();

    expect(root.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe(ru.l10n.probe);
    instance.unmount();
  });
});
