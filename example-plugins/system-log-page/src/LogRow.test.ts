// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it} from 'vitest';
import type {NormalizedLogRecord} from './log-types';
import LogRow from './LogRow.svelte';

describe('LogRow', () => {
  let host: HTMLElement;

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
