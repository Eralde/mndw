// @vitest-environment happy-dom
import {type MndwTable, defineMndwUi} from '@mndw/ui';
import {mount, unmount} from 'svelte';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ServiceEntry} from '../../services/service-client.js';
import type {ServiceRow} from './service-row.js';

const mockList = vi.fn<() => Promise<ServiceEntry[]>>();
const mockStatus = vi.fn<(name: string, signal?: AbortSignal) => Promise<ServiceEntry>>();
const mockStart = vi.fn<(name: string) => Promise<{ok: true; service: ServiceEntry}>>();
const mockStop = vi.fn<(name: string) => Promise<{ok: true; service: ServiceEntry}>>();
const mockRestart = vi.fn<(name: string) => Promise<{ok: true; service: ServiceEntry}>>();
const mockSetEnabled = vi.fn<(name: string, enabled: boolean) => Promise<{ok: true; service: ServiceEntry}>>();
const {openHostModal} = vi.hoisted(() => ({openHostModal: vi.fn()}));

vi.mock('../../services/overlay/host-overlay.js', () => ({openHostModal}));

vi.mock('../../services/service-client.js', () => ({
  ServiceError: Error,
  get serviceClient() {
    return {
      list: mockList,
      status: mockStatus,
      start: mockStart,
      stop: mockStop,
      restart: mockRestart,
      setEnabled: mockSetEnabled,
    };
  },
}));

import ServicesPanel from './ServicesPanel.svelte';

function tableRoot(host: HTMLElement): ShadowRoot {
  const table = host.querySelector('mndw-table');

  if (table?.shadowRoot === null || table?.shadowRoot === undefined) {
    throw new Error('expected service table shadow root');
  }

  return table.shadowRoot;
}

function rendererCell(host: HTMLElement, index: number): HTMLElement {
  const table = host.querySelector('mndw-table');
  const cells = Array.from(table?.children ?? []).filter((node): node is HTMLElement =>
    node instanceof HTMLElement && node.getAttribute('slot')?.startsWith('mc-') === true
  );
  const cell = cells[index];

  if (cell === undefined) {
    throw new Error(`expected renderer cell at index ${index}`);
  }

  return cell;
}

async function waitForTable(host: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    const table = host.querySelector('mndw-table');

    expect(table).not.toBeNull();
  });
  await vi.waitFor(() => expect(host.querySelector('mndw-switch')).not.toBeNull());
  await vi.waitFor(() => expect(host.querySelector('mndw-table')?.shadowRoot).not.toBeNull());
}

async function waitForRendererCells(host: HTMLElement, expectedCount = 4): Promise<void> {
  await waitForTable(host);
  await vi.waitFor(() => expect(host.querySelectorAll('[slot^="mc-"]').length).toBe(expectedCount));
}

const entry = (
  name: string,
  state: ServiceEntry['state'] = 'unknown',
  autostartPinned = false,
): ServiceEntry => ({
  name,
  label: name.slice(3),
  state,
  enabledAtBoot: name.startsWith('S'),
  autostartPinned,
  protected: false,
});

function createTarget(): HTMLElement {
  const target = document.createElement('div');

  document.body.appendChild(target);

  return target;
}

beforeAll(() => {
  defineMndwUi();
});

beforeEach(() => {
  mockList.mockReset();
  mockStatus.mockReset();
  mockStart.mockReset();
  mockStop.mockReset();
  mockRestart.mockReset();
  mockSetEnabled.mockReset();
  openHostModal.mockReset();
  openHostModal.mockReturnValue({closed: Promise.resolve({result: true})});
});

describe('ServicesPanel', () => {
  it('keeps refresh controls outside the bounded table viewport', async () => {
    const row = entry('S01a', 'running');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = createTarget();
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await waitForTable(target);

    const controls = target.querySelector('.mndw-table-controls');
    const table = target.querySelector('mndw-table');
    const viewport = tableRoot(target).querySelector('[part="viewport"]');

    expect(controls).not.toBeNull();
    expect(table).not.toBeNull();
    expect(controls?.contains(table ?? document.createElement('div'))).toBe(false);
    expect(viewport?.querySelector('table')).not.toBeNull();
    await unmount(app);
    target.remove();
  });

  it('probes every discovered row with at most three calls in flight', async () => {
    const rows = [entry('S01a'), entry('S02b'), entry('S03c'), entry('S04d')];

    mockList.mockResolvedValue(rows);

    let active = 0;
    let peak = 0;

    mockStatus.mockImplementation(async (name) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;

      return entry(name, 'running');
    });

    const target = createTarget();
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(rows.length));
    await waitForRendererCells(target, rows.length * 4);
    expect(peak).toBeLessThanOrEqual(3);
    expect(target.textContent).toContain('running');
    await unmount(app);
    target.remove();
  });
});

describe('ServicesPanel boot controls', () => {
  it('renders a PID only when status provides one', async () => {
    const rows = [entry('S01a')];

    mockList.mockResolvedValue(rows);
    mockStatus.mockResolvedValue({...rows[0], state: 'running', pid: 1516});

    const target = createTarget();
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await waitForRendererCells(target);
    expect(target.textContent).toContain('PID 1516');
    await unmount(app);
    target.remove();
  });

  it('renders Autostart as a switch and swaps the row after confirmation', async () => {
    const row = entry('S99foo', 'stopped');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);
    mockSetEnabled.mockResolvedValue({ok: true, service: entry('K99foo', 'stopped')});

    const target = createTarget();
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await waitForRendererCells(target);

    const headers = Array.from(tableRoot(target).querySelectorAll('[part="header-cell"]'))
      .map((header) => header.textContent);
    const autostartSwitch = rendererCell(target, 2).querySelector<HTMLElement & {checked: boolean}>('mndw-switch');

    expect(headers).toContain('Autostart');
    expect(autostartSwitch?.checked).toBe(true);

    autostartSwitch?.click();

    await vi.waitFor(() => expect(mockSetEnabled).toHaveBeenCalledWith('S99foo', false));
    expect(rendererCell(target, 0).querySelector('small')?.textContent).toBe('K99foo');
    expect(openHostModal).toHaveBeenCalled();
    await unmount(app);
    target.remove();
  });

  it('does not add an undefined tooltip to unprotected action buttons', async () => {
    const row = entry('S99foo', 'running');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = createTarget();
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await waitForRendererCells(target);

    const actionButtons = Array.from(rendererCell(target, 3).querySelectorAll('mndw-button'));

    expect(actionButtons).toHaveLength(3);
    expect(actionButtons[1]?.getAttribute('title')).toBeNull();
    expect(actionButtons[2]?.getAttribute('title')).toBeNull();
    await unmount(app);
    target.remove();
  });
});

describe('ServicesPanel pinned controls', () => {
  it('disables the toggle and explains pinned autostart', async () => {
    const row = entry('S95pinned', 'stopped', true);

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = createTarget();
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await waitForRendererCells(target);

    const autostartSwitch = rendererCell(target, 2).querySelector<HTMLElement & {disabled: boolean}>('mndw-switch');

    expect(autostartSwitch?.disabled).toBe(true);
    expect(autostartSwitch?.getAttribute('title')).toBe('Autostart is fixed by ENABLED= in the script');
    await unmount(app);
    target.remove();
  });

  it('pins a row when a stale toggle receives a conflict', async () => {
    const row = entry('S99foo', 'stopped');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);
    mockSetEnabled.mockRejectedValue(Object.assign(new Error('autostart is pinned'), {code: 'CONFLICT'}));

    const target = createTarget();
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await waitForRendererCells(target);
    rendererCell(target, 2).querySelector<HTMLElement>('mndw-switch')
      ?.click();

    await vi.waitFor(() =>
      expect(rendererCell(target, 2).querySelector<HTMLElement & {disabled: boolean}>('mndw-switch')?.disabled).toBe(
        true,
      )
    );
    expect(
      rendererCell(target, 2).querySelector('mndw-switch')
        ?.getAttribute('title'),
    ).toBe(
      'Autostart is fixed by ENABLED= in the script',
    );
    await unmount(app);
    target.remove();
  });
});

describe('ServicesPanel table sizing', () => {
  it('maps the legacy widths and min-width onto the mndw-table', async () => {
    const row = entry('S01a', 'running');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = createTarget();
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));

    const table = target.querySelector<MndwTable<ServiceRow>>('mndw-table');

    if (table === null) {
      throw new Error('mndw-table not rendered');
    }

    expect(table.columns.map((column) => column.width)).toEqual([
      '10rem',
      '7.1rem',
      '6.7rem',
      '18rem',
    ]);
    expect(table.minWidth).toBe('42rem');
    await unmount(app);
    target.remove();
  });
});
