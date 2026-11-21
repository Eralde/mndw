import type {PluginRciManager, RciQuery} from '@mndw/sdk';
import {type TestPluginContext, createTestPluginContext} from '@mndw/sdk/testing';
import {flushSync, mount, unmount} from 'svelte';
import {Observable, Subject, of, throwError} from 'rxjs';
import {afterEach, describe, expect, it, vi} from 'vitest';

import App from './App.svelte';
import {createContainer, createI18n} from './test-helpers.js';

type Queue = (query: RciQuery) => Observable<unknown>;

interface FakeRci {
  readonly rci: PluginRciManager;
  readonly queue: ReturnType<typeof vi.fn<Queue>>;
}

const mounted: Array<ReturnType<typeof mount>> = [];

function fakeRci(handler: Queue): FakeRci {
  const queue = vi.fn<Queue>(handler);

  return {rci: {queue} as unknown as PluginRciManager, queue};
}

function mountApp(
  rci: PluginRciManager,
  fixture: TestPluginContext = createTestPluginContext({overlay: {confirm: () => Promise.resolve(false)}}),
): HTMLElement {
  const container = createContainer();

  mounted.push(mount(App, {
    target: container,
    props: {rci, i18n: createI18n(), toast: fixture.context.toast, overlay: fixture.context.overlay},
  }));
  flushSync();

  return container;
}

function element<T extends HTMLElement>(container: HTMLElement, testId: string): T {
  const found = container.querySelector<T>(`[data-testid="${testId}"]`);

  if (found === null) {
    throw new Error(`Expected element with data-testid=${testId}`);
  }

  return found;
}

function click(container: HTMLElement, testId: string): void {
  element<HTMLButtonElement>(container, testId).click();
  flushSync();
}

function setDescription(container: HTMLElement, value: string): void {
  const input = element<HTMLInputElement>(container, 'description');

  input.value = value;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  flushSync();
}

function roleText(container: HTMLElement, role: 'alert' | 'status'): string {
  return container.querySelector(`[role="${role}"]`)?.textContent?.trim() ?? '';
}

function okResponse(): Observable<unknown> {
  return of({status: [{status: 'ok'}]});
}

afterEach(async () => {
  for (const app of mounted.splice(0)) {
    await unmount(app);
  }

  document.body.replaceChildren();
});

describe('RCI device-description widget', () => {
  it('keeps Save and Restore disabled until the initial device read succeeds', () => {
    const initialRead = new Subject<unknown>();
    const {rci, queue} = fakeRci(() => initialRead);
    const container = mountApp(rci);

    expect(queue).toHaveBeenCalledWith({path: 'show.version'});
    expect(element<HTMLButtonElement>(container, 'save').disabled).toBe(true);
    expect(element<HTMLButtonElement>(container, 'restore').disabled).toBe(true);

    initialRead.next({description: 'Original description'});
    initialRead.complete();
    flushSync();

    expect(element<HTMLInputElement>(container, 'description').value).toBe('Original description');
    expect(roleText(container, 'status')).toBe('Device description loaded.');
    expect(element<HTMLButtonElement>(container, 'save').disabled).toBe(true);
  });

  it('shows a load error, then retries successfully and permits a changed Save', () => {
    const retryRead = new Subject<unknown>();
    let readCount = 0;
    const {rci, queue} = fakeRci((query) => {
      if (query.path === 'show.version') {
        readCount += 1;

        if (readCount === 1) {
          return throwError(() => new Error('device offline'));
        }

        if (readCount === 2) {
          return retryRead;
        }

        return of({description: 'Recovered description'});
      }

      return okResponse();
    });
    const container = mountApp(rci);

    expect(roleText(container, 'alert')).toBe('Could not load the device description.');
    expect(element<HTMLButtonElement>(container, 'save').disabled).toBe(true);
    expect(element<HTMLButtonElement>(container, 'restore').disabled).toBe(true);
    expect(element<HTMLButtonElement>(container, 'retry').textContent).toBe('Retry');

    click(container, 'retry');

    expect(queue.mock.calls.filter(([query]) => query.path === 'show.version')).toHaveLength(2);
    expect(element<HTMLButtonElement>(container, 'save').disabled).toBe(true);

    retryRead.next({description: 'Recovered description'});
    retryRead.complete();
    flushSync();
    setDescription(container, 'New recovered name');

    expect(roleText(container, 'alert')).toBe('');
    expect(element<HTMLButtonElement>(container, 'save').disabled).toBe(false);

    click(container, 'save');

    expect(queue).toHaveBeenCalledWith({path: 'system.description', data: 'New recovered name'});
    expect(roleText(container, 'status')).toBe('Device description loaded.');
  });

  it('allows replacing an empty original but never enables Restore for it', () => {
    const {rci, queue} = fakeRci((query) => {
      if (query.path === 'show.version') {
        return of({description: '   '});
      }

      return okResponse();
    });
    const container = mountApp(rci);

    expect(element<HTMLInputElement>(container, 'description').value).toBe('');
    expect(element<HTMLButtonElement>(container, 'restore').disabled).toBe(true);
    expect(container.textContent).toContain('No non-empty original value is available to restore.');

    setDescription(container, 'New device description');

    expect(element<HTMLButtonElement>(container, 'save').disabled).toBe(false);

    click(container, 'save');

    expect(queue).toHaveBeenCalledWith({path: 'system.description', data: 'New device description'});
    expect(element<HTMLButtonElement>(container, 'restore').disabled).toBe(true);
    expect(container.textContent).toContain('No non-empty original value is available to restore.');
  });

  it('waits for write and a device confirmation read before recording one keyed success toast', () => {
    const fixture = createTestPluginContext({overlay: {confirm: () => Promise.resolve(false)}});
    const write = new Subject<unknown>();
    const confirmation = new Subject<unknown>();
    let readCount = 0;
    const {rci, queue} = fakeRci((query) => {
      if (query.path === 'show.version') {
        readCount += 1;

        return readCount === 1 ? of({description: 'Original'}) : confirmation;
      }

      return write;
    });
    const container = mountApp(rci, fixture);

    setDescription(container, 'Changed description');

    click(container, 'save');

    expect(queue.mock.calls.map(([query]) => query.path)).toEqual(['show.version', 'system.description']);
    expect(queue).toHaveBeenNthCalledWith(2, {path: 'system.description', data: 'Changed description'});
    expect(roleText(container, 'status')).toBe('Saving device description…');
    expect(fixture.toastCalls).toEqual([]);

    write.next({status: [{status: 'ok'}]});
    write.complete();
    flushSync();

    expect(queue.mock.calls.map(([query]) => query.path)).toEqual([
      'show.version',
      'system.description',
      'show.version',
    ]);
    expect(roleText(container, 'status')).toBe('Saving device description…');
    expect(fixture.toastCalls).toEqual([]);

    confirmation.next({description: 'Changed description'});
    confirmation.complete();
    flushSync();

    expect(element<HTMLInputElement>(container, 'description').value).toBe('Changed description');
    expect(roleText(container, 'status')).toBe('Device description loaded.');
    expect(fixture.toastCalls).toEqual([
      {
        type: 'success',
        message: 'Device description confirmed by device.',
        options: {key: 'saved'},
        handleId: 1,
      },
    ]);
  });

  it('ignores a second Save while the accepted write transaction is pending', () => {
    const write = new Subject<unknown>();
    const {rci, queue} = fakeRci((query) => {
      return query.path === 'show.version' ? of({description: 'Original'}) : write;
    });
    const container = mountApp(rci);

    setDescription(container, 'Changed description');

    const save = element<HTMLButtonElement>(container, 'save');

    save.click();
    save.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    expect(queue.mock.calls.filter(([query]) => query.path === 'system.description')).toHaveLength(1);
    expect(roleText(container, 'status')).toBe('Saving device description…');
  });

  it('shows embedded RCI status errors without starting a confirmation read', () => {
    const {rci, queue} = fakeRci((query) => {
      return query.path === 'show.version'
        ? of({description: 'Original'})
        : of({status: [{status: 'error', message: 'Description rejected by device'}]});
    });
    const container = mountApp(rci);

    setDescription(container, 'Changed description');

    click(container, 'save');

    expect(roleText(container, 'alert')).toBe('Description rejected by device');
    expect(queue.mock.calls.map(([query]) => query.path)).toEqual(['show.version', 'system.description']);
    expect(element<HTMLButtonElement>(container, 'save').disabled).toBe(false);
  });

  it('recovers from a transport error so a later Save can succeed', () => {
    let readCount = 0;
    let writeCount = 0;
    const {rci, queue} = fakeRci((query) => {
      if (query.path === 'show.version') {
        readCount += 1;

        return of({description: readCount === 1 ? 'Original' : 'Changed description'});
      }

      writeCount += 1;

      return writeCount === 1 ? throwError(() => new Error('transport unavailable')) : okResponse();
    });
    const container = mountApp(rci);

    setDescription(container, 'Changed description');

    click(container, 'save');

    expect(roleText(container, 'alert')).toBe('Could not save the device description.');
    expect(element<HTMLButtonElement>(container, 'save').disabled).toBe(false);

    click(container, 'save');

    expect(writeCount).toBe(2);
    expect(queue.mock.calls.filter(([query]) => query.path === 'system.description')).toHaveLength(2);
    expect(roleText(container, 'status')).toBe('Device description loaded.');
  });

  it('does not ask before saving a typed value', () => {
    let readCount = 0;
    const confirm = vi.fn(() => Promise.resolve(false));
    const fixture = createTestPluginContext({overlay: {confirm}});
    const {rci} = fakeRci((query) => {
      if (query.path === 'show.version') {
        readCount += 1;

        return of({description: readCount === 1 ? 'Original' : 'Changed description'});
      }

      return okResponse();
    });
    const container = mountApp(rci, fixture);

    setDescription(container, 'Changed description');
    click(container, 'save');

    expect(confirm).not.toHaveBeenCalled();
    expect(element<HTMLButtonElement>(container, 'restore').disabled).toBe(false);
  });

  it('asks before restoring and does not write when the user cancels', async () => {
    let readCount = 0;
    const writes: string[] = [];
    const confirm = vi.fn(() => Promise.resolve(false));
    const fixture = createTestPluginContext({overlay: {confirm}});
    const {rci} = fakeRci((query) => {
      if (query.path === 'show.version') {
        readCount += 1;

        return of({description: readCount === 1 ? 'Original' : writes[writes.length - 1]});
      }

      if (typeof query.data !== 'string') {
        throw new Error('Expected string description write');
      }

      writes.push(query.data);

      return okResponse();
    });
    const container = mountApp(rci, fixture);

    setDescription(container, 'Changed description');
    click(container, 'save');
    click(container, 'restore');

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({
      title: 'Restore the original description?',
      message: 'Write back “Original”?',
      confirmLabel: 'Restore original',
    });
    expect(writes).toEqual(['Changed description']);
    expect(element<HTMLInputElement>(container, 'description').value).toBe('Changed description');
  });

  it('restores the original non-empty value after confirmation', async () => {
    let readCount = 0;
    const writes: string[] = [];
    const confirm = vi.fn(() => Promise.resolve(true));
    const fixture = createTestPluginContext({overlay: {confirm}});
    const {rci, queue} = fakeRci((query) => {
      if (query.path === 'show.version') {
        readCount += 1;

        return of({description: readCount === 1 ? 'Original' : writes[writes.length - 1]});
      }

      if (typeof query.data !== 'string') {
        throw new Error('Expected string description write');
      }

      writes.push(query.data);

      return okResponse();
    });
    const container = mountApp(rci, fixture);

    setDescription(container, 'Changed description');
    click(container, 'save');

    expect(element<HTMLButtonElement>(container, 'restore').disabled).toBe(false);

    click(container, 'restore');

    await vi.waitFor(() => expect(writes).toEqual(['Changed description', 'Original']));
    flushSync();

    expect(confirm).toHaveBeenCalledWith({
      title: 'Restore the original description?',
      message: 'Write back “Original”?',
      confirmLabel: 'Restore original',
    });
    expect(queue).toHaveBeenNthCalledWith(4, {path: 'system.description', data: 'Original'});
    expect(element<HTMLInputElement>(container, 'description').value).toBe('Original');
    expect(roleText(container, 'status')).toBe('Device description loaded.');
  });

  it('unsubscribes an active initial read when the component is destroyed', async () => {
    const teardown = vi.fn();
    const {rci} = fakeRci(() => new Observable<unknown>(() => teardown));
    const container = mountApp(rci);
    const app = mounted.pop();

    if (app !== undefined) {
      await unmount(app);
    }

    expect(container.childElementCount).toBe(0);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes an active write when the component is destroyed', async () => {
    const teardown = vi.fn();
    const {rci} = fakeRci((query) => {
      return query.path === 'show.version' ? of({description: 'Original'}) : new Observable<unknown>(() => teardown);
    });
    const container = mountApp(rci);

    setDescription(container, 'Changed description');
    click(container, 'save');

    const app = mounted.pop();

    if (app !== undefined) {
      await unmount(app);
    }

    expect(container.childElementCount).toBe(0);
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
