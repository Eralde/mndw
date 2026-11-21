// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ServiceEntry} from '../../services/service-client.js';
import {createHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';

const mockList = vi.fn<() => Promise<ServiceEntry[]>>();
const mockStatus = vi.fn<(name: string, signal?: AbortSignal) => Promise<ServiceEntry>>();
const mockSetEnabled = vi.fn<(name: string, enabled: boolean) => Promise<{ok: true; service: ServiceEntry}>>();
const {confirmHost} = vi.hoisted(() => ({confirmHost: vi.fn()}));

vi.mock('../../services/overlay/host-overlay.js', () => ({confirmHost}));

vi.mock('../../services/service-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/service-client.js')>();

  return {
    ...actual,
    ServiceError: Error,
    createServiceClient: () => ({
      list: mockList,
      status: mockStatus,
      setEnabled: mockSetEnabled,
    }),
  };
});

import ServicesPanel from './ServicesPanel.svelte';

const context = createHostServicesContext(createHostServices());

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
  confirmHost.mockReset();
  confirmHost.mockResolvedValue(true);
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

    const app = mount(ServicesPanel, {target: host, context});

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    await vi.waitFor(() => expect(host.querySelector('mndw-switch')).not.toBeNull());

    const root = tableRoot(host);

    expect(root?.querySelectorAll('[part="header-cell"]')).toHaveLength(4);
    expect(root?.querySelectorAll('[part="row"]')).toHaveLength(1);
    expect(host.querySelectorAll('mndw-button').length).toBeGreaterThan(0);

    await unmount(app);
  });
});
