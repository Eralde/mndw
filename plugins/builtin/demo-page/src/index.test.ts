import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createInstance} from './index';

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
      hostInfo: {deviceName: 'Router', vendor: 'Keenetic'},
      storage: {get: vi.fn().mockResolvedValue(null), set: storageSet},
    } as unknown as PluginContext;

    host = document.createElement('div');
    document.body.append(host);

    instance = await createInstance(host, ctx);

    expect(host.querySelector('button')).toBeNull();

    const saveButton = host.querySelector<HTMLElement>('#hello-page-save');

    if (saveButton === null) {
      throw new Error('save button was not rendered');
    }

    saveButton.click();
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith('count', '0'));
    expect(host.textContent).toContain('(saved: 0)');
  });
});
