import type {PluginRciManager} from '@mndw/sdk';
import {of} from 'rxjs';
import {flushSync, mount, unmount} from 'svelte';
import {expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import App from './App.svelte';
import en from '../i18n/en.json';

it('saves a new description and displays the read-back value', async () => {
  const queue = vi.fn()
    .mockReturnValueOnce(of({description: 'Original'}))
    .mockReturnValueOnce(of({status: [{status: 'ok'}]}))
    .mockReturnValueOnce(of({description: 'Confirmed by device'}));
  const root = document.createElement('div');

  document.body.append(root);

  const app = mount(App, {
    target: root,
    props: {rci: {queue} as unknown as PluginRciManager, i18n: createTestI18n(en)},
  });

  try {
    flushSync();

    const input = root.querySelector<HTMLInputElement>('input');

    if (!input) {
      throw new Error('Missing input');
    }

    expect(input.value).toBe('Original');
    input.value = ' New ';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    flushSync();
    root.querySelector<HTMLButtonElement>('[data-testid="save"]')?.click();
    flushSync();
    expect(queue.mock.calls).toEqual([
      [{path: 'show.version'}],
      [{path: 'system.description', data: 'New'}],
      [{path: 'show.version'}],
    ]);
    expect(input.value).toBe('Confirmed by device');
    expect(root.textContent).toContain(en.status.saved);
  } finally {
    await unmount(app);
    root.remove();
  }
});
