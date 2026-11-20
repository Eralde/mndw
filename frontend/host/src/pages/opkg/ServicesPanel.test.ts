// @vitest-environment happy-dom
import {type MndwTable, defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ServiceEntry} from '../../services/service-client.js';
import type {ServiceRow} from './service-row.js';
import {createHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';
import {TestResizeObserver} from './test-resize-observer.js';

const mockList = vi.fn<() => Promise<ServiceEntry[]>>();
const mockStatus = vi.fn<(name: string, signal?: AbortSignal) => Promise<ServiceEntry>>();
const mockStart = vi.fn<(name: string) => Promise<{ok: true; service: ServiceEntry}>>();
const mockStop = vi.fn<(name: string) => Promise<{ok: true; service: ServiceEntry}>>();
const mockRestart = vi.fn<(name: string) => Promise<{ok: true; service: ServiceEntry}>>();
const mockSetEnabled = vi.fn<(name: string, enabled: boolean) => Promise<{ok: true; service: ServiceEntry}>>();
const {openHostModal} = vi.hoisted(() => ({openHostModal: vi.fn()}));
const context = createHostServicesContext(createHostServices());

vi.mock('../../services/overlay/host-overlay.js', () => ({openHostModal}));

vi.mock('../../services/service-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/service-client.js')>();

  return {
    ...actual,
    ServiceError: Error,
    createServiceClient: () => ({
      list: mockList,
      status: mockStatus,
      start: mockStart,
      stop: mockStop,
      restart: mockRestart,
      setEnabled: mockSetEnabled,
    }),
  };
});

import ServicesPanel from './ServicesPanel.svelte';
import PackageManager from './PackageManager.svelte';

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
  TestResizeObserver.reset();
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  mockList.mockReset();
  mockStatus.mockReset();
  mockStart.mockReset();
  mockStop.mockReset();
  mockRestart.mockReset();
  mockSetEnabled.mockReset();
  openHostModal.mockReset();
  openHostModal.mockReturnValue({closed: Promise.resolve({result: true})});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServicesPanel loading', () => {
  it('shows loading during the first request and the empty state only after it succeeds', async () => {
    let resolveList: ((rows: ServiceEntry[]) => void) | undefined;

    mockList.mockImplementation(() =>
      new Promise((resolve) => {
        resolveList = resolve;
      })
    );

    const target = createTarget();
    const app = mount(ServicesPanel, {target, context});

    await vi.waitFor(() => expect(mockList).toHaveBeenCalledOnce());

    const status = target.querySelector('[role="status"]');

    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('Loading…');
    expect(target.textContent).not.toContain('No services found');

    if (resolveList === undefined) {
      throw new Error('service list request was not started');
    }

    resolveList([]);

    await vi.waitFor(() =>
      expect(target.querySelector('.mndw-empty-state')?.textContent).toContain('No services found')
    );
    await unmount(app);
    target.remove();
  });

  it('keeps unsupported service capability as a muted status', async () => {
    mockList.mockRejectedValue(Object.assign(new Error('unsupported'), {code: 'SERVICE_UNAVAILABLE'}));

    const target = createTarget();
    const app = mount(ServicesPanel, {target, context});

    await vi.waitFor(() => expect(target.querySelector('.capability[role="status"]')).not.toBeNull());
    expect(target.querySelector('[role="alert"]')).toBeNull();
    await unmount(app);
    target.remove();
  });

  it('marks a failed service list as an alert and offers retry in place', async () => {
    mockList.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);

    const target = createTarget();
    const app = mount(ServicesPanel, {target, context});

    await vi.waitFor(() => expect(target.querySelector('[role="alert"]')).not.toBeNull());
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Failed to load services');
    expect(target.querySelector('[role="alert"]')?.classList.contains('mndw-alert--danger')).toBe(true);
    target.querySelector<HTMLElement>('[role="alert"] mndw-button')?.click();
    await vi.waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(target.querySelector('.mndw-empty-state')).not.toBeNull());
    await unmount(app);
    target.remove();
  });

  it('keeps loaded rows visible while refreshing', async () => {
    const row = entry('S01a', 'running');
    let resolveRefresh: ((rows: ServiceEntry[]) => void) | undefined;

    mockList.mockResolvedValueOnce([row]).mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    mockStatus.mockResolvedValue(row);

    const target = createTarget();
    const app = mount(ServicesPanel, {target, context});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledOnce());
    await waitForTable(target);
    target.querySelector<HTMLElement>('.mndw-table-controls mndw-button')?.click();
    await vi.waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));

    expect(target.querySelector('mndw-table')).not.toBeNull();
    expect(target.textContent).toContain('S01a');
    expect(target.textContent).not.toContain('Loading…');

    if (resolveRefresh === undefined) {
      throw new Error('service refresh request was not started');
    }

    resolveRefresh([row]);
    await unmount(app);
    target.remove();
  });
});

describe('ServicesPanel', () => {
  it('keeps refresh controls outside the bounded table viewport', async () => {
    const row = entry('S01a', 'running');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = createTarget();
    const app = mount(ServicesPanel, {target, context});

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
    const app = mount(ServicesPanel, {target, context});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(rows.length));
    await waitForRendererCells(target, rows.length * 4);
    expect(peak).toBeLessThanOrEqual(3);
    expect(target.textContent).toContain('Running');
    await unmount(app);
    target.remove();
  });
});

describe('PackageManager services heading', () => {
  it('shows one Entware heading above tabs and keeps the service toolbar together', async () => {
    const originalPathname = window.location.pathname;

    window.history.replaceState(null, '', '/packages/services');
    mockList.mockResolvedValue([]);

    const target = createTarget();
    const app = mount(PackageManager, {target, context});

    try {
      await vi.waitFor(() => expect(target.querySelector('.header-row')).not.toBeNull());

      const heading = target.querySelector('h1');
      const toolbar = target.querySelector('.header-row');

      expect(target.querySelectorAll('h1')).toHaveLength(1);
      expect(heading?.textContent).toBe('Entware');
      expect(heading?.nextElementSibling?.tagName.toLowerCase()).toBe('mndw-tabs');
      expect(toolbar?.querySelector('h1')).toBeNull();
      expect(toolbar?.querySelector('p')?.textContent).toBe('Inspect and control device init services.');
      expect(toolbar?.querySelector('mndw-button')?.textContent?.trim()).toBe('Refresh states');
    } finally {
      await unmount(app);
      target.remove();
      window.history.replaceState(null, '', originalPathname);
    }
  });
});

describe('ServicesPanel boot controls', () => {
  it('renders a PID only when status provides one', async () => {
    const rows = [entry('S01a')];

    mockList.mockResolvedValue(rows);
    mockStatus.mockResolvedValue({...rows[0], state: 'running', pid: 1516});

    const target = createTarget();
    const app = mount(ServicesPanel, {target, context});

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
    const app = mount(ServicesPanel, {target, context});

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

  it('does not add an undefined title to unprotected action buttons', async () => {
    const row = entry('S99foo', 'running');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = createTarget();
    const app = mount(ServicesPanel, {target, context});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await waitForRendererCells(target);

    const actionButtons = Array.from(rendererCell(target, 3).querySelectorAll('mndw-button'));

    expect(actionButtons).toHaveLength(2);
    expect(actionButtons[0]?.getAttribute('title')).toBeNull();
    expect(actionButtons[1]?.getAttribute('title')).toBeNull();
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
    const app = mount(ServicesPanel, {target, context});

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
    const app = mount(ServicesPanel, {target, context});

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
    const app = mount(ServicesPanel, {target, context});

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

describe('ServicesPanel compact layout', () => {
  it('moves service state and autostart into the name cell below the panel-width breakpoint', async () => {
    const row = {...entry('S01a', 'running', true), pid: 1234};

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = createTarget();
    const app = mount(ServicesPanel, {target, context});

    await waitForTable(target);

    const table = target.querySelector<MndwTable<ServiceRow>>('mndw-table');

    if (table === null) {
      throw new Error('mndw-table not rendered');
    }

    const panel = target.querySelector('.services-panel');

    if (panel === null) {
      throw new Error('Expected services panel');
    }

    const observer = TestResizeObserver.observing(panel);

    observer.resize(360);
    flushSync();

    await vi.waitFor(() => expect(table.hiddenColumns).toEqual(['state', 'autostart']));
    expect(table.rows[0]?.compact).toBe(true);
    expect(table.minWidth).toBe('');
    expect(table.columns.find((column) => column.id === 'service')?.width).toBe('8rem');
    await vi.waitFor(() => expect(rendererCell(target, 0).textContent).toContain('Running'));
    expect(rendererCell(target, 0).textContent).toContain('1234');

    const compactSwitch = rendererCell(target, 0).querySelector('mndw-switch');

    expect(compactSwitch?.getAttribute('aria-label')).toBe('Disable at boot');

    observer.resize(640);
    flushSync();

    await vi.waitFor(() => expect(table.hiddenColumns).toEqual([]));
    expect(table.rows[0]?.compact).toBe(false);
    expect(table.minWidth).toBe('42rem');
    expect(table.columns.find((column) => column.id === 'service')?.width).toBe('10rem');
    await vi.waitFor(() => expect(rendererCell(target, 0).querySelector('.compact-details')).toBeNull());

    await unmount(app);
    target.remove();
  });
});
