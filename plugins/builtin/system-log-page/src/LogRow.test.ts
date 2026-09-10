// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it} from 'vitest';
import type {NormalizedLogRecord} from './log-types';
import LogRow from './LogRow.svelte';

describe('LogRow', () => {
  let host: HTMLElement;

  it('exposes every normalized level through text and a styling hook', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    for (const level of ['Info', 'Warning', 'Error', 'Critical', 'Debug', 'Notice'] as const) {
      const record: NormalizedLogRecord = {
        id: 1,
        timestamp: 'Aug  1 12:00:00',
        ident: 'system',
        level,
        label: level,
        text: `message for ${level}`,
      };
      const app = mount(LogRow, {target: host, props: {record, query: ''}});

      flushSync();

      const row = host.querySelector<HTMLElement>('[data-log-id="1"]');

      expect(row?.getAttribute('data-level')).toBe(level);
      expect(row?.querySelector('[data-level-marker]')).not.toBeNull();
      expect(row?.textContent).toContain(level);
      expect(row?.textContent).toContain('Aug  1 12:00:00');
      expect(row?.textContent).toContain('system');
      expect(row?.textContent).toContain(`message for ${level}`);

      await unmount(app);
    }
  });

  it.each(
    [
      ['Info', 'info'],
      ['Notice', 'info'],
      ['Warning', 'circle-alert'],
      ['Error', 'circle-x'],
    ] as const,
  )('renders the %s level as the %s shared icon', (level, name) => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const record: NormalizedLogRecord = {
      id: 1,
      timestamp: 'Aug  1 12:00:00',
      ident: 'system',
      level,
      label: level,
      text: `message for ${level}`,
    };
    const app = mount(LogRow, {target: host, props: {record, query: ''}});

    flushSync();

    const marker = host.querySelector<HTMLElement & {name?: string}>('[data-level-marker]');

    expect(marker?.name).toBe(name);

    void unmount(app);
  });

  afterEach(() => {
    host?.remove();
  });

  it('renders level indicator and unsafe device text as DOM text', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const record: NormalizedLogRecord = {
      id: 1,
      timestamp: 'Aug  1 12:00:00',
      ident: 'system',
      level: 'Error',
      label: 'Error',
      text: '<script>alert(1)</script>',
    };
    const app = mount(LogRow, {target: host, props: {record, query: 'script'}});

    flushSync();

    expect(host.textContent).toContain('<script>alert(1)</script>');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('mark')?.textContent).toBe('script');
    expect(host.textContent).toContain('Error');

    await unmount(app);
  });
});
