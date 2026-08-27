// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import {useTranslator} from '@mndw/sdk/vue';
import {type App as VueApp, createApp} from 'vue';
import ColumnSettings from './ColumnSettings.vue';

type MndwCheckboxHost = HTMLElement & {checked: boolean};

let host: HTMLElement;
let app: VueApp | null = null;
let onChange: ReturnType<typeof vi.fn>;
let onRefreshIntervalChange: ReturnType<typeof vi.fn>;

function mountSettings(): void {
  host = document.createElement('div');
  document.body.append(host);
  onChange = vi.fn();
  onRefreshIntervalChange = vi.fn();
  app = createApp(ColumnSettings, {
    visibility: {ip: true, connection: false, uptime: true, lastSeen: true},
    refreshIntervalSeconds: 3,
    onChange,
    onRefreshIntervalChange,
    translator: useTranslator(createTestI18n({
      'columns': 'Columns',
      'refresh-interval': 'Refresh interval',
      'column.ip': 'IP Address',
      'column.connection': 'Connection',
      'column.uptime': 'Uptime',
      'column.last-seen': 'Last Seen',
    })),
  });
  app.mount(host);
}

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
});

describe('ColumnSettings shared controls', () => {
  it('renders shared checkbox and slider controls', () => {
    mountSettings();

    expect(host.querySelectorAll('input')).toHaveLength(0);
    expect(host.querySelectorAll('mndw-checkbox')).toHaveLength(4);
    expect(host.querySelector('mndw-slider')).not.toBeNull();
  });

  it('forwards checkbox changes from mndwchange detail', () => {
    mountSettings();

    const checkbox = host.querySelector<MndwCheckboxHost>('mndw-checkbox');

    if (checkbox === null) {
      throw new Error('column checkbox was not rendered');
    }

    checkbox.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: false, indeterminate: false},
      }),
    );

    expect(onChange).toHaveBeenCalledWith('ip', false);
  });

  it('forwards slider values from mndwinput detail', () => {
    mountSettings();

    const slider = host.querySelector('mndw-slider');

    if (slider === null) {
      throw new Error('refresh slider was not rendered');
    }

    slider.dispatchEvent(
      new CustomEvent('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: 7},
      }),
    );

    expect(onRefreshIntervalChange).toHaveBeenCalledWith(7);
  });
});
