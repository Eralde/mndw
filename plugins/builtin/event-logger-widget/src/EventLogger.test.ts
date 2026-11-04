import {flushSync, mount, unmount} from 'svelte';
import {expect, it} from 'vitest';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import EventLogger from './EventLogger.svelte';
import messages from '../i18n/en.json';

it('bounds capture, freezes while paused, clears locally, filters and cleans up', async () => {
  const fixture = createTestPluginContext({events: true});
  const target = document.createElement('div');

  document.body.append(target);

  const app = mount(EventLogger, {
    target,
    props: {events: fixture.context.events, i18n: createTestI18n(messages)},
  });
  const emitWithoutFlush = (id: string): void => {
    fixture.emitEvent({
      id,
      ts: 1725552000123,
      topic: 'wan.disconnected',
      source: 'hook',
      payload: {interface: id},
    });
  };
  const emit = (id: string): void => {
    emitWithoutFlush(id);
    flushSync();
  };
  const emitResync = (): void => {
    fixture.resync();
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

    for (let index = 0; index < 501; index++) {
      emitWithoutFlush(`event-${index}`);
    }

    flushSync();
    expect(target.querySelectorAll('details')).toHaveLength(500);
    expect(target.querySelector('pre')?.textContent).toContain('event-500');
    click('Pause');
    emit('ignored');
    emitResync();
    expect(target.textContent).not.toContain('ignored');
    expect(target.querySelector('.marker')).toBeNull();
    click('Clear');
    emit('still-ignored');
    expect(target.querySelectorAll('details')).toHaveLength(0);
    click('Resume');
    expect(target.textContent).toContain('Capture resumed');
    emit('captured');
    emitResync();
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
    fixture.unmount();
    target.remove();
  }
});

it('shows unavailable state without an event facade', async () => {
  const target = document.createElement('div');
  const app = mount(EventLogger, {target, props: {events: undefined, i18n: createTestI18n(messages)}});

  flushSync();
  expect(target.textContent).toContain('Event stream unavailable');
  expect(target.querySelector('mndw-button')).toBeNull();
  await unmount(app);
});
