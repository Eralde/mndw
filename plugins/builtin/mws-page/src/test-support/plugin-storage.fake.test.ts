import {describe, expect, it} from 'vitest';
import {FakePluginStorage} from './plugin-storage.fake';

describe('FakePluginStorage', () => {
  it('round-trips values and records calls', async () => {
    const storage = new FakePluginStorage();

    await storage.set('key', 'value');

    await expect(storage.get('key')).resolves.toBe('value');
    expect(storage.get).toHaveBeenCalledWith('key');
    expect(await storage.keys()).toEqual(['key']);

    await storage.delete('key');
    await expect(storage.get('key')).resolves.toBeNull();
  });

  it('resolves delayed reads only when released', async () => {
    const storage = new FakePluginStorage({mode: 'resolve-on-demand'});
    let settled = false;
    const pending = storage.get('node-positions').then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    storage.resolveGet(null);
    await pending;
    expect(settled).toBe(true);
  });
});
