// @vitest-environment happy-dom
import {flushSync} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import type {BackendClient, PluginContext} from '@mndw/sdk';
import enCatalog from '../i18n/en.json';
import {createInstance} from './index';

afterEach(() => vi.restoreAllMocks());

describe('createInstance', () => {
  it('mounts with the typed backend client', () => {
    const host = document.createElement('div');
    const backend = {fetch: vi.fn(), socket: vi.fn()} as unknown as BackendClient;
    const context = {
      backend,
      i18n: createTestI18n(enCatalog),
    } as unknown as PluginContext;

    document.body.appendChild(host);

    const instance = createInstance(host, context);

    flushSync();

    const labels = [...host.querySelectorAll('mndw-button')].map((b) => b.textContent ?? '');

    expect(labels.some((t) => /router cli|entware shell/i.test(t))).toBe(true);
    instance.unmount();
    host.remove();
  });
});
