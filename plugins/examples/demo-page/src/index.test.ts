import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {createInstance} from './index';
import enCatalog from '../i18n/en.json';

let host: HTMLElement;
let instance: PluginInstance | null = null;

afterEach(() => {
  instance?.unmount();
  instance = null;
  host?.remove();
});

describe('createInstance', () => {
  it('renders a shared save control and persists the current count', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      instanceId: 'demo-1',
      hostInfo: {locale: 'en', theme: 'dark'},
      deviceInfo: {deviceName: 'Router', vendor: 'Keenetic'},
      storage: {get: vi.fn().mockResolvedValue(null), set: storageSet},
      i18n: createTestI18n(enCatalog),
    } as unknown as PluginContext;

    host = document.createElement('div');
    document.body.append(host);

    instance = await createInstance(host, ctx);

    expect(host.querySelector('.demo-page')).not.toBeNull();
    expect(host.querySelector('.demo-page__content')).not.toBeNull();
    expect(host.querySelector('.demo-page__actions')).not.toBeNull();
    expect(host.querySelector('button')).toBeNull();

    const saveButton = host.querySelector<HTMLElement>('#hello-page-save');

    if (saveButton === null) {
      throw new Error('save button was not rendered');
    }

    saveButton.click();
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith('count', '0'));
    expect(host.textContent).toContain('(saved: 0)');
  });

  it('updates the same control and probe after a locale switch', async () => {
    const i18n = createTestI18n({
      'l10n': {probe: 'Demo English'},
      'instance-id': 'Instance EN',
      'device': 'Device EN',
      'vendor': 'Vendor EN',
      'count': 'Count EN: {count}',
      'save': 'Save EN',
    });
    const ctx = {
      instanceId: 'demo-1',
      hostInfo: {locale: 'en', theme: 'dark'},
      deviceInfo: {deviceName: 'Router', vendor: 'Keenetic'},
      storage: {get: vi.fn().mockResolvedValue(null), set: vi.fn()},
      i18n,
    } as unknown as PluginContext;

    host = document.createElement('div');
    document.body.append(host);
    instance = await createInstance(host, ctx);

    const probe = host.querySelector<HTMLElement>('[data-testid="l10n-probe"]');
    const save = host.querySelector<HTMLElement>('#hello-page-save');

    expect(probe?.textContent).toBe('Demo English');
    expect(probe?.hidden).toBe(true);
    expect(save?.textContent).toBe('Save EN');
    i18n.setLocale('ru', {
      'l10n': {probe: 'Демо русский'},
      'instance-id': 'Экземпляр RU',
      'device': 'Устройство RU',
      'vendor': 'Производитель RU',
      'count': 'Счётчик RU: {count}',
      'save': 'Сохранить RU',
    });

    expect(host.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe('Демо русский');
    expect(host.querySelector('#hello-page-save')).toBe(save);
    expect(save?.textContent).toBe('Сохранить RU');
  });
});
