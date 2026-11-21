import type {RciQuery} from '@mndw/sdk';
import {flushSync} from 'svelte';
import {of} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {createInstance} from './index.js';
import {createContainer, createI18n} from './test-helpers.js';

describe('RCI device-description widget plugin entry', () => {
  it('passes the context RCI manager and feedback services to the component', async () => {
    let readCount = 0;
    const writes: string[] = [];
    const queue = vi.fn((query: RciQuery) => {
      if (query.path === 'show.version') {
        readCount += 1;

        return of({description: readCount === 1 ? 'Original' : writes[writes.length - 1]});
      }

      if (typeof query.data !== 'string') {
        throw new Error('Expected string description write');
      }

      writes.push(query.data);

      return of({status: [{status: 'ok'}]});
    });
    const confirm = vi.fn(() => Promise.resolve(true));
    const fixture = createTestPluginContext({
      device: {rci: {queue}},
      i18n: createI18n(),
      overlay: {confirm},
    });
    const container = createContainer();
    const instance = createInstance(container, fixture.context);

    flushSync();

    expect(queue).toHaveBeenCalledWith({path: 'show.version'});

    const input = container.querySelector<HTMLInputElement>('[data-testid="description"]');

    if (input === null) {
      throw new Error('Expected the description input');
    }

    input.value = 'Changed description';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    flushSync();
    container.querySelector<HTMLButtonElement>('[data-testid="save"]')?.click();
    flushSync();

    expect(fixture.toastCalls).toEqual([
      {
        type: 'success',
        message: 'Device description confirmed by device.',
        options: {key: 'saved'},
        handleId: 1,
      },
    ]);

    container.querySelector<HTMLButtonElement>('[data-testid="restore"]')?.click();

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({
      title: 'Restore the original description?',
      message: 'Write back “Original”?',
      confirmLabel: 'Restore original',
    });

    instance.unmount();
    await vi.waitFor(() => expect(container.childElementCount).toBe(0));
  });

  it('updates the host widget title when the locale changes', async () => {
    const queue = vi.fn((_query: RciQuery) => of({description: 'Original'}));
    const i18n = createTestI18n({title: 'Device description EN'});
    const fixture = createTestPluginContext({kind: 'widget', i18n, device: {rci: {queue}}});
    const container = createContainer();
    const instance = createInstance(container, fixture.context);

    flushSync();
    expect(fixture.tileTitles.at(-1)).toBe('Device description EN');
    expect(container.querySelector('h2')).toBeNull();
    i18n.setLocale('ru', {title: 'Описание устройства RU'});
    flushSync();

    expect(fixture.tileTitles.at(-1)).toBe('Описание устройства RU');
    await instance.unmount();
  });
});
