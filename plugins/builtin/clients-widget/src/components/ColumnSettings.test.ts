// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import {useTranslator} from '@mndw/sdk/vue';
import {type App as VueApp, createApp, nextTick} from 'vue';
import ColumnSettings from './ColumnSettings.vue';
import {DEFAULT_RSSI_THRESHOLDS, type RssiThresholds} from './rssi.js';

type MndwCheckboxHost = HTMLElement & {checked: boolean};
type MndwCheckboxWithUpdate = MndwCheckboxHost & {updateComplete: Promise<unknown>};
type MndwSliderHost = HTMLElement & {
  updateComplete: Promise<unknown>;
  value: number;
  valueFormatter: (value: number) => string;
};
type MndwInputHost = HTMLElement & {value: string; type: string};
type MndwFieldHost = HTMLElement & {updateComplete: Promise<unknown>};

let host: HTMLElement;
let app: VueApp | null = null;
let onChange: ReturnType<typeof vi.fn>;
let onRefreshIntervalChange: ReturnType<typeof vi.fn>;
let onRssiThresholdsChange: ReturnType<typeof vi.fn>;

function mountSettings(rssiThresholds: RssiThresholds = DEFAULT_RSSI_THRESHOLDS): void {
  host = document.createElement('div');
  document.body.append(host);
  onChange = vi.fn();
  onRefreshIntervalChange = vi.fn();
  onRssiThresholdsChange = vi.fn();
  app = createApp(ColumnSettings, {
    visibility: {ip: true, connection: false, uptime: true, lastSeen: true},
    refreshIntervalSeconds: 3,
    rssiThresholds,
    onChange,
    onRefreshIntervalChange,
    onRssiThresholdsChange,
    translator: useTranslator(createTestI18n({
      'columns': 'Columns',
      'refresh-interval': 'Refresh interval',
      'rssi-thresholds.label': 'RSSI thresholds',
      'rssi-thresholds.good': 'Good signal threshold (dBm)',
      'rssi-thresholds.fair': 'Fair signal threshold (dBm)',
      'rssi-thresholds.invalid': 'Enter a whole number from {min} to {max} dBm',
      'rssi-thresholds.order': 'Must be above the fair threshold',
      'column.ip': 'IP address',
      'column.connection': 'Connection',
      'column.uptime': 'Uptime',
      'column.last-seen': 'Last seen',
    })),
  });
  app.mount(host);
}

function thresholdInputs(): [MndwInputHost, MndwInputHost] {
  const inputs = [...host.querySelectorAll<MndwInputHost>('mndw-input')];

  if (inputs.length !== 2) {
    throw new Error(`expected two threshold inputs, got ${inputs.length}`);
  }

  return [inputs[0], inputs[1]];
}

function inputValue(input: MndwInputHost, value: string): void {
  input.dispatchEvent(
    new CustomEvent('mndwinput', {
      bubbles: true,
      composed: true,
      detail: {value},
    }),
  );
}

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
});

describe('ColumnSettings shared controls', () => {
  it('renders shared checkbox, slider, and number input controls', () => {
    mountSettings();

    expect(host.querySelectorAll('input')).toHaveLength(0);
    expect(host.querySelectorAll('mndw-checkbox')).toHaveLength(4);
    expect(host.querySelector('mndw-slider')).not.toBeNull();
    expect([...host.querySelectorAll<MndwInputHost>('mndw-input')].map((input) => input.type))
      .toEqual(['number', 'number']);
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

  it('keeps a column checkbox visibly toggled after its change callback', async () => {
    mountSettings();

    const checkbox = host.querySelector<MndwCheckboxWithUpdate>('mndw-checkbox');

    if (checkbox === null) {
      throw new Error('column checkbox was not rendered');
    }

    await checkbox.updateComplete;
    checkbox.click();
    await checkbox.updateComplete;

    expect(checkbox.getAttribute('aria-checked')).toBe('false');
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

  it('formats the current slider value without showing a duplicate value', async () => {
    mountSettings();

    const slider = host.querySelector<MndwSliderHost>('mndw-slider');

    if (slider === null) {
      throw new Error('refresh slider was not rendered');
    }

    await slider.updateComplete;
    slider.dispatchEvent(
      new CustomEvent('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: 7},
      }),
    );
    slider.value = 7;
    await Promise.resolve();
    await slider.updateComplete;

    expect(slider.valueFormatter(slider.value)).toBe('7s');
    expect(slider.shadowRoot?.querySelector('[part="output"]')?.textContent).toBe('7s');
    expect(slider.getAttribute('aria-valuetext')).toBe('7s');
    expect(host.querySelector('.clients-settings__value')).toBeNull();
    expect(onRefreshIntervalChange).toHaveBeenCalledWith(7);
  });
});

describe('ColumnSettings RSSI thresholds', () => {
  it('shows the current thresholds', () => {
    mountSettings({good: -60, fair: -70});

    expect(thresholdInputs().map((input) => input.value)).toEqual(['-60', '-70']);
  });

  it('reports each valid change with both values', () => {
    mountSettings();

    const [good, fair] = thresholdInputs();

    inputValue(good, '-60');
    inputValue(fair, '-70');

    expect(onRssiThresholdsChange).toHaveBeenNthCalledWith(1, {good: -60, fair: -75});
    expect(onRssiThresholdsChange).toHaveBeenNthCalledWith(2, {good: -60, fair: -70});
  });

  it.each(['-10', '-65.5', ''])('does not report the invalid value %j and shows a field error', async (value) => {
    mountSettings();

    const [good] = thresholdInputs();

    inputValue(good, value);
    await nextTick();

    expect(onRssiThresholdsChange).not.toHaveBeenCalled();

    const field = host.querySelectorAll<MndwFieldHost>('mndw-field')[1];

    await field.updateComplete;

    expect(field.querySelector('.mndw-field__error')?.textContent)
      .toBe('Enter a whole number from -100 to -20 dBm');
  });

  it('does not report a good threshold that is not above the fair one', async () => {
    mountSettings();

    const [good] = thresholdInputs();

    inputValue(good, '-80');
    await nextTick();

    expect(onRssiThresholdsChange).not.toHaveBeenCalled();

    const field = host.querySelectorAll<MndwFieldHost>('mndw-field')[1];

    await field.updateComplete;

    expect(field.querySelector('.mndw-field__error')?.textContent).toBe('Must be above the fair threshold');
  });
});
