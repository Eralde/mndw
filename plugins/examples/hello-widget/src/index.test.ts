import {flushSync} from 'svelte';
import {describe, expect, it, vi} from 'vitest';
import type {PluginContext} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {createInstance} from './index.js';
import {createContainer, createI18n} from './test-helpers.js';

describe('hello widget plugin entry', () => {
  it('unmounts the Svelte component through PluginInstance', async () => {
    const container = createContainer();
    const fixture = createTestPluginContext({i18n: createI18n()});
    const context = fixture.context;
    const instance = createInstance(container, context);

    flushSync();
    expect(container.querySelector('[data-testid="greet"]')).not.toBeNull();

    instance.unmount();
    await vi.waitFor(() => expect(container.childElementCount).toBe(0));
    fixture.unmount();
  });

  it('updates the host widget title when the locale changes', async () => {
    const container = createContainer();
    const i18n = createTestI18n({title: 'Hello EN'});
    const setTileTitle = vi.fn();
    const fixture = createTestPluginContext({i18n});
    const context = {
      ...fixture.context,
      setTileTitle,
    } as unknown as PluginContext;
    const instance = createInstance(container, context);

    flushSync();
    expect(setTileTitle).toHaveBeenLastCalledWith('Hello EN');
    expect(container.querySelector('h2')).toBeNull();
    i18n.setLocale('ru', {title: 'Привет RU'});
    flushSync();

    expect(setTileTitle).toHaveBeenLastCalledWith('Привет RU');
    await instance.unmount();
    fixture.unmount();
  });
});
