import {flushSync, mount, unmount} from 'svelte';
import {expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import App from './App.svelte';
import en from '../i18n/en.json';

it('calls the route id and displays its greeting', async () => {
  const call = vi.fn().mockResolvedValue({message: 'Hello test'});
  const signal = new AbortController().signal;
  const root = document.createElement('div');

  document.body.append(root);

  const app = mount(App, {
    target: root,
    props: {
      backend: {call} as unknown as BackendClient,
      i18n: createTestI18n(en),
      signal,
    },
  });

  try {
    flushSync();
    root.querySelector<HTMLElement>('[data-testid="greet"]')?.click();
    await vi.waitFor(() => expect(root.textContent).toContain('Hello test'));
    expect(call).toHaveBeenCalledWith('hello', {as: 'json', signal});
  } finally {
    await unmount(app);
    root.remove();
  }
});
