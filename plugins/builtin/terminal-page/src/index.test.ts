// @vitest-environment happy-dom
import {flushSync} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient, PluginContext} from '@mndw/sdk';
import {createInstance} from './index';

afterEach(() => vi.restoreAllMocks());

describe('createInstance', () => {
  it('mounts with the typed backend client', () => {
    const host = document.createElement('div');
    const backend = {fetch: vi.fn(), socket: vi.fn()} as unknown as BackendClient;
    const context = {backend} as unknown as PluginContext;

    document.body.appendChild(host);

    const instance = createInstance(host, context);

    flushSync();

    const labels = [...host.querySelectorAll('mndw-button')].map((b) => b.textContent ?? '');

    expect(labels.some((t) => /router cli|entware shell/i.test(t))).toBe(true);
    instance.unmount();
    host.remove();
  });
});
