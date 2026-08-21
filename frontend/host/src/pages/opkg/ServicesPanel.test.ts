import {defineMndwUi} from '@mndw/ui';
import {mount, unmount} from 'svelte';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ServiceEntry} from '../../services/service-client.js';

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

beforeAll(() => defineMndwUi());

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

    const target = document.createElement('div');
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(rows.length));
    expect(peak).toBeLessThanOrEqual(3);
    expect(target.textContent).toContain('running');
    await unmount(app);
  });
});

describe('ServicesPanel boot controls', () => {
  it('renders a PID only when status provides one', async () => {
    const rows = [entry('S01a')];

    mockList.mockResolvedValue(rows);
    mockStatus.mockResolvedValue({...rows[0], state: 'running', pid: 1516});

    const target = document.createElement('div');
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    expect(target.textContent).toContain('PID 1516');
    await unmount(app);
  });

  it('renders Autostart as a switch and swaps the row after confirmation', async () => {
    const row = entry('S99foo', 'stopped');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);
    mockSetEnabled.mockResolvedValue({ok: true, service: entry('K99foo', 'stopped')});

    const target = document.createElement('div');
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));

    const headers = Array.from(target.querySelectorAll('thead th')).map((header) => header.textContent);
    const autostartSwitch = target.querySelector<HTMLElement & {checked: boolean}>('tbody tr mndw-switch');

    expect(headers).toContain('Autostart');
    expect(autostartSwitch?.checked).toBe(true);

    autostartSwitch?.click();

    await vi.waitFor(() => expect(mockSetEnabled).toHaveBeenCalledWith('S99foo', false));
    expect(target.querySelector('tbody tr small')?.textContent).toBe('K99foo');
    expect(openHostModal).toHaveBeenCalled();
    await unmount(app);
  });

  it('does not add an undefined tooltip to unprotected action buttons', async () => {
    const row = entry('S99foo', 'running');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = document.createElement('div');
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));

    const actionButtons = Array.from(target.querySelectorAll('tbody tr mndw-button'));

    expect(actionButtons).toHaveLength(3);
    expect(actionButtons[1]?.getAttribute('title')).toBeNull();
    expect(actionButtons[2]?.getAttribute('title')).toBeNull();
    await unmount(app);
  });
});

describe('ServicesPanel pinned controls', () => {
  it('disables the toggle and explains pinned autostart', async () => {
    const row = entry('S95pinned', 'stopped', true);

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const target = document.createElement('div');
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));

    const autostartSwitch = target.querySelector<HTMLElement & {disabled: boolean}>('tbody tr mndw-switch');

    expect(autostartSwitch?.disabled).toBe(true);
    expect(autostartSwitch?.getAttribute('title')).toBe('Autostart is fixed by ENABLED= in the script');
    await unmount(app);
  });

  it('pins a row when a stale toggle receives a conflict', async () => {
    const row = entry('S99foo', 'stopped');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);
    mockSetEnabled.mockRejectedValue(Object.assign(new Error('autostart is pinned'), {code: 'CONFLICT'}));

    const target = document.createElement('div');
    const app = mount(ServicesPanel, {target});

    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    target.querySelector<HTMLElement>('tbody tr mndw-switch')?.click();

    await vi.waitFor(() =>
      expect(target.querySelector<HTMLElement & {disabled: boolean}>('tbody tr mndw-switch')?.disabled).toBe(true)
    );
    expect(target.querySelector('tbody tr mndw-switch')?.getAttribute('title')).toBe(
      'Autostart is fixed by ENABLED= in the script',
    );
    await unmount(app);
  });
});
