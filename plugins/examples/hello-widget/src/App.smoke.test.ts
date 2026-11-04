import {flushSync, mount, unmount} from 'svelte';
import {expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import App from './App.svelte';
import en from '../i18n/en.json';

it('calls the route id and displays its greeting', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({message: 'Hello test'})),
  );
  const root = document.createElement('div');

  document.body.append(root);

  const app = mount(App, {
    target: root,
    props: {
      backend: {fetch} as unknown as BackendClient,
      i18n: createTestI18n(en),
    },
  });

  try {
    flushSync();
    root.querySelector<HTMLElement>('[data-testid="greet"]')?.click();
    await vi.waitFor(() => expect(root.textContent).toContain('Hello test'));
    expect(fetch).toHaveBeenCalledWith('hello');
  } finally {
    await unmount(app);
    root.remove();
  }
});
