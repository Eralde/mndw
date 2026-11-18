import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
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
    const fixture = createTestPluginContext({instanceId: 'demo-1', i18n: createTestI18n(enCatalog)});
    const ctx = withOverrides(fixture.context, {
      device: {...fixture.context.device,
        info: {...fixture.context.device.info, deviceName: 'Router', vendor: 'Keenetic'}},
      storage: {...fixture.context.storage, instance: {
        ...fixture.context.storage.instance,
        get: vi.fn().mockResolvedValue(null),
        set: storageSet,
      }},
    });

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

  it('updates visible text and control after a locale switch', async () => {
    const i18n = createTestI18n({
      'instance-id': 'Instance EN',
      'device': 'Device EN',
      'vendor': 'Vendor EN',
      'count': 'Count EN: {count}',
      'save': 'Save EN',
    });
    const fixture = createTestPluginContext({instanceId: 'demo-1', i18n});
    const ctx = withOverrides(fixture.context, {
      device: {...fixture.context.device,
        info: {...fixture.context.device.info, deviceName: 'Router', vendor: 'Keenetic'}},
      storage: {...fixture.context.storage, instance: {
        ...fixture.context.storage.instance,
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      }},
    });

    host = document.createElement('div');
    document.body.append(host);
    instance = await createInstance(host, ctx);

    const save = host.querySelector<HTMLElement>('#hello-page-save');
    const device = host.querySelector('#hello-page-device');

    expect(save?.textContent).toBe('Save EN');
    expect(device?.textContent).toContain('Device EN');
    i18n.setLocale('ru', {
      'instance-id': 'Экземпляр RU',
      'device': 'Устройство RU',
      'vendor': 'Производитель RU',
      'count': 'Счётчик RU: {count}',
      'save': 'Сохранить RU',
    });

    expect(host.querySelector('#hello-page-save')).toBe(save);
    expect(save?.textContent).toBe('Сохранить RU');
    expect(device?.textContent).toContain('Устройство RU');
  });
});

function withOverrides(context: PluginContext, overrides: Partial<PluginContext>): PluginContext {
  const copy = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(context);

  for (const descriptor of Object.values(descriptors)) {
    descriptor.configurable = true;
  }

  Object.defineProperties(copy, descriptors);
  Object.defineProperties(
    copy,
    Object.fromEntries(
      Object.entries(overrides).map(([key, value]) => [key, {configurable: true, enumerable: true, value}]),
    ),
  );

  return Object.freeze(copy) as unknown as PluginContext;
}
