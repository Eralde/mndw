// @vitest-environment happy-dom

import type {BackendClient, PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {describe, expect, it, vi} from 'vitest';

import {createInstance} from './index.js';

const contextFor = (
  i18n: ReturnType<typeof createTestI18n>,
  backend?: Partial<BackendClient>,
  kind: 'widget' | 'page' = 'page',
  setTileTitle = vi.fn(),
): PluginContext => {
  const fixture = createTestPluginContext({i18n, backend: backend as BackendClient | undefined, kind});

  return Object.assign(Object.create(fixture.context), {setTileTitle}) as PluginContext;
};

describe('generated Go locale reactivity', () => {
  it('updates visible control and result without remounting', () => {
    const en = {l10n: {title: 'Plugin title', button: 'Run English', result: 'English result', error: 'Error'}};
    const ru = {l10n: {title: 'Заголовок', button: 'Запустить', result: 'Русский result', error: 'Ошибка'}};
    const i18n = createTestI18n(en, 'en');
    const root = document.createElement('div');
    const instance = createInstance(root, contextFor(i18n));
    const title = root.querySelector('h2');
    const button = root.querySelector('mndw-button');
    const result = root.querySelector('[data-testid="l10n-result"]');

    expect(title?.textContent).toBe(en.l10n.title);
    expect(root.querySelector('section')?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(button?.textContent).toBe(en.l10n.button);
    expect(result?.textContent?.trim()).toBe(en.l10n.result);
    i18n.setLocale('ru', ru);

    expect(title?.textContent).toBe(ru.l10n.title);
    expect(button?.textContent).toBe(ru.l10n.button);
    expect(result?.textContent?.trim()).toBe(ru.l10n.result);
    instance.unmount();
  });

  it('sets a translated host title for widgets without drawing an internal heading', () => {
    const en = {l10n: {title: 'Plugin title', button: 'Run', result: 'Result', error: 'Error'}};
    const ru = {l10n: {title: 'Заголовок', button: 'Запустить', result: 'Результат', error: 'Ошибка'}};
    const i18n = createTestI18n(en, 'en');
    const setTileTitle = vi.fn();
    const root = document.createElement('div');
    const instance = createInstance(root, contextFor(i18n, undefined, 'widget', setTileTitle));

    expect(setTileTitle).toHaveBeenLastCalledWith(en.l10n.title);
    expect(root.querySelector('h2')).toBeNull();
    expect(root.firstElementChild?.hasAttribute('aria-labelledby')).toBe(false);
    i18n.setLocale('ru', ru);

    expect(setTileTitle).toHaveBeenLastCalledWith(ru.l10n.title);
    instance.unmount();
  });

  it('updates the localized result label after a backend response', async () => {
    const en = {l10n: {title: 'Plugin title', button: 'Run English', result: 'English result', error: 'Error'}};
    const ru = {l10n: {title: 'Заголовок', button: 'Запустить', result: 'Русский result', error: 'Ошибка'}};
    const i18n = createTestI18n(en, 'en');
    const call = vi.fn().mockResolvedValue({message: 'hello'});
    const root = document.createElement('div');
    const instance = createInstance(root, contextFor(i18n, {call}));
    const result = root.querySelector('[data-testid="l10n-result"]');

    root.querySelector('mndw-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => {
      expect(result?.textContent?.trim()).toBe('English result: hello');
    });

    i18n.setLocale('ru', ru);

    expect(result?.textContent?.trim()).toBe('Русский result: hello');
    instance.unmount();
  });
});
