import type {RciManager, RciQuery} from '@rci-tools/core';
import {flushSync} from 'svelte';
import {of} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import type {PluginContext} from '@mndw/sdk';
import {createInstance} from './index.js';
import {createContainer, createI18n} from './test-helpers.js';

describe('RCI device-description widget plugin entry', () => {
  it('passes the context RCI manager to the component and delegates unmount', async () => {
    const queue = vi.fn((_query: RciQuery) => of({description: 'Original'}));
    const rciManager = {queue} as unknown as RciManager;
    const context = {rciManager, i18n: createI18n()} as unknown as PluginContext;
    const container = createContainer();
    const instance = createInstance(container, context);

    flushSync();

    expect(queue).toHaveBeenCalledWith({path: 'show.version'});
    expect(container.querySelector('[data-testid="description"]')).not.toBeNull();

    instance.unmount();
    await vi.waitFor(() => expect(container.childElementCount).toBe(0));
  });
});
