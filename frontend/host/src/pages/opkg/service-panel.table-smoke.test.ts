import {defineMndwUi} from '@mndw/ui';
import {mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ServiceEntry} from '../../services/service-client.js';

const mockList = vi.fn<() => Promise<ServiceEntry[]>>();
const mockStatus = vi.fn<(name: string, signal?: AbortSignal) => Promise<ServiceEntry>>();
const mockSetEnabled = vi.fn<(name: string, enabled: boolean) => Promise<{ok: true; service: ServiceEntry}>>();
const {openHostModal} = vi.hoisted(() => ({openHostModal: vi.fn()}));

vi.mock('../../services/overlay/host-overlay.js', () => ({openHostModal}));

vi.mock('../../services/service-client.js', () => ({
  ServiceError: Error,
  get serviceClient() {
    return {
      list: mockList,
      status: mockStatus,
      setEnabled: mockSetEnabled,
    };
  },
}));

import ServicesPanel from './ServicesPanel.svelte';

const entry = (name: string): ServiceEntry => ({
  name,
  label: name,
  state: 'running',
  enabledAtBoot: true,
  autostartPinned: false,
  protected: false,
});

function tableRoot(host: HTMLElement): ShadowRoot | null {
  return host.querySelector('mndw-table')?.shadowRoot ?? null;
}

let host: HTMLElement;

beforeAll(() => {
  defineMndwUi();
});

beforeEach(() => {
  mockList.mockReset();
  mockStatus.mockReset();
  mockSetEnabled.mockReset();
  openHostModal.mockReset();
  openHostModal.mockReturnValue({closed: Promise.resolve({result: true})});
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('ServicesPanel table smoke', () => {
  it('renders table chrome and interactive cells once services load', async () => {
    const row = entry('S01a');

    mockList.mockResolvedValue([row]);
    mockStatus.mockResolvedValue(row);

    const app = mount(ServicesPanel, {target: host});

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    await vi.waitFor(() => expect(host.querySelector('mndw-switch')).not.toBeNull());

    const root = tableRoot(host);

    expect(root?.querySelectorAll('[part="header-cell"]')).toHaveLength(4);
    expect(root?.querySelectorAll('[part="row"]')).toHaveLength(1);
    expect(host.querySelectorAll('mndw-button').length).toBeGreaterThan(0);

    await unmount(app);
  });
});
