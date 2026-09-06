import {flushSync, mount, unmount} from 'svelte';
import {expect, it, vi} from 'vitest';
import type {MndwEvent, PluginEventFacade} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import EventLogger from './EventLogger.svelte';
import messages from '../i18n/en.json';

it('bounds capture, freezes while paused, clears locally, filters and cleans up', async () => {
  let deliver: (event: MndwEvent) => void = () => {};
  let resync: () => void = () => {};
  const cancel = vi.fn();
  const cancelResync = vi.fn();
  const subscribe = vi.fn<PluginEventFacade['subscribe']>((_topics, handler) => {
    deliver = handler;

    return cancel;
  });
  const events: PluginEventFacade = {
    subscribe,
    onResync: (handler) => {
      resync = handler;

      return cancelResync;
    },
  };
  const target = document.createElement('div');

  document.body.append(target);

  const app = mount(EventLogger, {target, props: {events, i18n: createTestI18n(messages)}});
  const emit = (id: string): void => {
    deliver({id, ts: 1725552000123, topic: 'wan.disconnected', source: 'hook', payload: {interface: id}});
    flushSync();
  };
  const click = (label: string): void => {
    const button = [...target.querySelectorAll('mndw-button')].find((item) => {
      return item.textContent?.trim() === label;
    });

    expect(button).toBeDefined();
    button?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();
  };

  try {
    flushSync();
    expect(subscribe).toHaveBeenCalledWith('*', expect.any(Function));

    for (let index = 0; index < 501; index++) {
      emit(`event-${index}`);
    }

    expect(target.querySelectorAll('details')).toHaveLength(500);
    expect(target.querySelector('pre')?.textContent).toContain('event-500');
    click('Pause');
    emit('ignored');
    resync();
    flushSync();
    expect(target.textContent).not.toContain('ignored');
    expect(target.querySelector('.marker')).toBeNull();
    click('Clear');
    emit('still-ignored');
    expect(target.querySelectorAll('details')).toHaveLength(0);
    expect(cancel).not.toHaveBeenCalled();
    click('Resume');
    expect(target.textContent).toContain('Capture resumed');
    emit('captured');
    resync();
    flushSync();
    expect(target.textContent).toContain(messages.resync);
    target.querySelector('mndw-input')?.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: 'captured'}}));
    flushSync();
    expect(target.querySelectorAll('details')).toHaveLength(1);
    expect(target.querySelector('.marker')).toBeNull();
    click('Clear');
    emit('captured-again');
    expect(target.querySelectorAll('details')).toHaveLength(1);
  } finally {
    await unmount(app);
    target.remove();
  }

  expect(cancel).toHaveBeenCalledOnce();
  expect(cancelResync).toHaveBeenCalledOnce();
});

it('shows unavailable state without an event facade', async () => {
  const target = document.createElement('div');
  const app = mount(EventLogger, {target, props: {events: undefined, i18n: createTestI18n(messages)}});

  flushSync();
  expect(target.textContent).toContain('Event stream unavailable');
  expect(target.querySelector('mndw-button')).toBeNull();
  await unmount(app);
});
