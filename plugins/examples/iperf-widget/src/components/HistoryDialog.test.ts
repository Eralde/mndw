// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import type {Translator} from '@mndw/sdk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {HistoryEntry} from '../model/history.js';
import HistoryDialog from './HistoryDialog.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];

function createTranslator(): Translator {
  const labels: Record<string, string> = {
    'history.empty': 'No completed tests yet.',
    'result.download': 'Download',
    'result.upload': 'Upload',
    'result.ping': 'Ping',
    'action.close': 'Close',
  };

  return {
    t: (key) => labels[key] ?? key,
    formatNumber: (value, options) => new Intl.NumberFormat('en', options).format(value),
    formatDate: () => 'Jan 2, 2025, 3:04 AM',
    locale: 'en',
    direction: 'ltr',
  };
}

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((app) => unmount(app)));
});

describe('HistoryDialog', () => {
  it('renders two lines with labelled download, upload and ping values and no header row', () => {
    const target = document.createElement('div');
    const entry: HistoryEntry = {
      at: Date.UTC(2025, 0, 2, 3, 4),
      server: 'example.net:5201',
      pingMs: 7,
      jitterMs: 1,
      downloadBps: 412_000_000,
      uploadBps: 188_000_000,
    };
    const translator = createTranslator();
    const app = mount(HistoryDialog, {
      target,
      props: {history: [entry], translator, onClose: vi.fn()},
    });

    mounted.push(app);
    flushSync();

    const rows = target.querySelectorAll('[role="listitem"]');
    const row = rows[0];
    const values = Array.from(
      row?.querySelectorAll('.entry-values > span') ?? [],
      (value) => value.textContent?.trim(),
    );

    expect(target.querySelector('.history-header')).toBeNull();
    expect(rows).toHaveLength(1);
    expect(row?.textContent).toContain('Jan 2, 2025, 3:04 AM');
    expect(row?.textContent).toContain('example.net:5201');
    expect(values).toEqual(['↓ 412 Mbit/s', '↑ 188 Mbit/s', 'Ping 7 ms']);
    expect(row?.querySelectorAll('.entry-meta, .entry-values')).toHaveLength(2);
    expect(row?.querySelectorAll('.entry-values [aria-label]')).toHaveLength(3);
    expect(row?.querySelector('.entry-values [aria-label="Download: 412 Mbit/s"]')).not.toBeNull();
    expect(row?.querySelector('.entry-values [aria-label="Upload: 188 Mbit/s"]')).not.toBeNull();
    expect(row?.querySelector('.entry-values .download-value')?.textContent?.trim()).toBe('412 Mbit/s');
    expect(row?.querySelector('.entry-values .upload-value')?.textContent?.trim()).toBe('188 Mbit/s');
  });

  it('closes through the UI kit button', () => {
    const target = document.createElement('div');
    const onClose = vi.fn();
    const app = mount(HistoryDialog, {
      target,
      props: {history: [], translator: createTranslator(), onClose},
    });

    mounted.push(app);
    flushSync();

    const close = target.querySelector<HTMLElement>('mndw-button');

    expect(close?.textContent).toContain('Close');
    close?.click();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows an em dash for a saved run with no ping samples', () => {
    const target = document.createElement('div');
    const entry: HistoryEntry = {
      at: Date.UTC(2025, 0, 2, 3, 4),
      server: 'example.net:5201',
      pingMs: null,
      jitterMs: null,
      downloadBps: 412_000_000,
      uploadBps: 188_000_000,
    };
    const app = mount(HistoryDialog, {
      target,
      props: {history: [entry], translator: createTranslator(), onClose: vi.fn()},
    });

    mounted.push(app);
    flushSync();

    const ping = target.querySelector('.entry-values [aria-label^="Ping:"]');

    expect(ping?.textContent).toContain('—');
    expect(ping?.getAttribute('aria-label')).toBe('Ping: —');
  });
});
