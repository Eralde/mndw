// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import type {OverlayLayer, OverlayOpenOptions, PluginContext} from '@mndw/sdk';
import {openSettingsDialog} from './open-settings-dialog.js';

interface Opened {
  options: OverlayOpenOptions;
  target: HTMLElement;
  cleanup: (() => void) | null;
}

function createContext(): {ctx: PluginContext; opened: Opened[]} {
  const opened: Opened[] = [];

  const open = (options: OverlayOpenOptions): unknown => {
    const target = document.createElement('div');

    document.body.append(target);

    const record: Opened = {options, target, cleanup: null};
    const layer = {
      setCleanup: (fn: () => void) => {
        record.cleanup = fn;
      },
      close: vi.fn(),
    } as unknown as OverlayLayer;

    opened.push(record);
    void options.mount(target, layer, new AbortController().signal);

    return layer;
  };

  return {
    ctx: {overlay: {open}} as unknown as PluginContext,
    opened,
  };
}

const visibility = {ip: true, connection: false, uptime: true, lastSeen: true};

function openDialog(): {
  opened: Opened;
  onChange: ReturnType<typeof vi.fn>;
  onRefreshIntervalChange: ReturnType<typeof vi.fn>;
} {
  const {ctx, opened} = createContext();
  const onChange = vi.fn();
  const onRefreshIntervalChange = vi.fn();

  openSettingsDialog(ctx, visibility, 3, onChange, onRefreshIntervalChange);

  return {opened: opened[0], onChange, onRefreshIntervalChange};
}

describe('overlay options', () => {
  it('opens a modal with the specified title, width, and dismissal', () => {
    const {opened} = openDialog();

    expect(opened.options.kind).toBe('modal');
    expect(opened.options.title).toBe('Client settings');
    expect(opened.options.width).toBe(280);
    expect(opened.options.closeOnOutsideClick).toBe(true);
  });

  it('registers a cleanup that unmounts the Vue app', () => {
    const {opened} = openDialog();

    expect(opened.cleanup).toBeTypeOf('function');
    expect(opened.target.querySelector('input')).not.toBeNull();

    opened.cleanup?.();
    expect(opened.target.querySelector('input')).toBeNull();
  });

  it('returns void — the session is intentionally discarded', () => {
    const {ctx} = createContext();

    expect(openSettingsDialog(ctx, visibility, 3, vi.fn(), vi.fn())).toBeUndefined();
  });
});

describe('column checkboxes', () => {
  it('renders exactly the four toggleable columns and no others', () => {
    const {opened} = openDialog();
    const labels = [...opened.target.querySelectorAll('label')]
      .filter((label) => label.querySelector('input[type="checkbox"]'))
      .map((label) => label.textContent?.trim());

    expect(labels).toEqual(['IP Address', 'Connection', 'Uptime', 'Last Seen']);
    expect(opened.target.textContent).not.toContain('Name');
    expect(opened.target.textContent).not.toContain('Link');
  });

  it('reflects incoming visibility', () => {
    const {opened} = openDialog();
    const boxes = [...opened.target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

    expect(boxes.map((box) => box.checked)).toEqual([true, false, true, true]);
  });

  it('reports a toggle without closing the dialog', () => {
    const {opened, onChange} = openDialog();
    const connection = opened.target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];

    connection.checked = true;
    connection.dispatchEvent(new Event('change', {bubbles: true}));

    expect(onChange).toHaveBeenCalledWith('connection', true);
    expect(opened.target.querySelector('input')).not.toBeNull();
  });
});

describe('interval slider', () => {
  it('renders a 1..10 range bound to the current value', () => {
    const {opened} = openDialog();
    const slider = opened.target.querySelector<HTMLInputElement>('input[type="range"]');

    expect(slider?.min).toBe('1');
    expect(slider?.max).toBe('10');
    expect(slider?.step).toBe('1');
    expect(slider?.value).toBe('3');
  });

  it('reports an integer, not the raw string', () => {
    const {opened, onRefreshIntervalChange} = openDialog();
    const slider = opened.target.querySelector<HTMLInputElement>('input[type="range"]');

    if (slider === null) {
      throw new Error('no range input rendered');
    }

    slider.value = '7';
    slider.dispatchEvent(new Event('input', {bubbles: true}));

    expect(onRefreshIntervalChange).toHaveBeenCalledWith(7);
  });
});
