import {flushSync} from 'svelte';
import {describe, expect, it, vi} from 'vitest';
import type {BackendClient, PluginContext} from '@mndw/sdk';
import {createInstance} from './index.js';
import {createContainer, createI18n} from './test-helpers.js';

describe('hello widget plugin entry', () => {
  it('unmounts the Svelte component through PluginInstance', async () => {
    const container = createContainer();
    const context = {
      backend: {fetch: vi.fn()} as unknown as BackendClient,
      i18n: createI18n(),
    } as unknown as PluginContext;
    const instance = createInstance(container, context);

    flushSync();
    expect(container.querySelector('[data-testid="greet"]')).not.toBeNull();

    instance.unmount();
    await vi.waitFor(() => expect(container.childElementCount).toBe(0));
  });
});
