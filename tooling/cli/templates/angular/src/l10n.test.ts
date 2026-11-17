// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import type {BackendClient, PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it, vi} from 'vitest';
import {createInstance} from './index.js';

async function stabilize(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('generated Angular locale reactivity', () => {
  it('updates visible control and result without remounting', async () => {
    const en = {l10n: {title: 'Plugin title', button: 'Run English', result: 'English result', error: 'Error'}};
    const ru = {l10n: {title: 'Заголовок', button: 'Запустить', result: 'Русский результат', error: 'Ошибка'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const context = createTestPluginContext({i18n}).context;
    const instance = createInstance(root, context);
    await stabilize();
    const title = root.querySelector('h2');
    const button = root.querySelector('mndw-button');
    const result = root.querySelector('[data-testid="l10n-result"]');

    expect(title?.textContent).toBe(en.l10n.title);
    expect(button?.textContent).toContain(en.l10n.button);
    expect(result?.textContent?.trim()).toBe(en.l10n.result);
    i18n.setLocale('ru', ru);
    await stabilize();

    expect(button?.textContent).toContain(ru.l10n.button);
    expect(title?.textContent).toBe(ru.l10n.title);
    expect(result?.textContent?.trim()).toBe(ru.l10n.result);
    instance.unmount();
  });

  it('calls the backend when the shared button is clicked', async () => {
    const call = vi.fn().mockResolvedValue({message: 'hello'});
    const i18n = createTestI18n({
      l10n: {title: 'Plugin title', button: 'Run', result: 'Backend response', error: 'Unavailable'},
    });
    const fixture = createTestPluginContext({i18n, backend: {call} as unknown as BackendClient});
    const root = document.createElement('div');
    const instance = createInstance(root, fixture.context);
    await stabilize();

    root.querySelector('mndw-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith('hello', {as: 'json'});
      expect(root.querySelector('[data-testid="l10n-result"]')?.textContent?.trim()).toBe('Backend response: hello');
    });

    instance.unmount();
    fixture.unmount();
  });
});
