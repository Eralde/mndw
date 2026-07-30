import {afterEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import PendingApprovals from './PendingApprovals.svelte';

const item: PluginListEntry = {
  type: 'page',
  name: 'network-tools',
  version: '1.0.0',
  label: 'Network Tools',
  entry: 'index.js',
  source: 'user',
  approval: 'pending',
  enabled: false,
  depsStatus: 'ready',
  route: '/network-tools',
  backend: {
    endpoints: {status: {method: 'GET', path: '/api/status'}},
    websockets: {},
    opkg: ['curl'],
    daemon: false,
    public: false,
  },
};

function mountPendingApprovals(props: Partial<{
  items: PluginListEntry[];
  busyName: string | null;
  confirmingName: string | null;
  actionError: {name: string; message: string} | null;
  onApprove: (name: string) => void;
  onDeny: (name: string) => void;
  onRequestConfirm: (name: string) => void;
  onCancelConfirm: () => void;
}> = {}): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(PendingApprovals, {
    target,
    props: {
      items: [item],
      busyName: null,
      confirmingName: null,
      actionError: null,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
      onRequestConfirm: vi.fn(),
      onCancelConfirm: vi.fn(),
      ...props,
    },
  });

  flushSync();

  return {component, target};
}

describe('PendingApprovals', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('approves a pending plugin', () => {
    const onApprove = vi.fn();
    const {component, target} = mountPendingApprovals({onApprove});

    expect(target.textContent).toContain('Pending approvals');
    expect(target.textContent).toContain('Network Tools');
    expect(target.textContent).toContain('network-tools');
    expect(target.textContent).toContain('status: GET /api/status');

    target.querySelector<HTMLButtonElement>('.mndw-pending__approve')?.click();

    expect(onApprove).toHaveBeenCalledWith('network-tools');

    void unmount(component);
  });

  it('requests denial confirmation without local confirmation state', () => {
    const onRequestConfirm = vi.fn();
    const {component, target} = mountPendingApprovals({onRequestConfirm});

    target.querySelector<HTMLButtonElement>('.mndw-pending__deny')?.click();

    expect(onRequestConfirm).toHaveBeenCalledWith('network-tools');
    expect(target.querySelector('.mndw-pending__confirm')).toBeNull();

    void unmount(component);
  });

  it('denies after parent supplies matching confirmation state', () => {
    const onDeny = vi.fn();
    const onCancelConfirm = vi.fn();
    const {component, target} = mountPendingApprovals({
      confirmingName: 'network-tools',
      onDeny,
      onCancelConfirm,
    });

    expect(target.querySelector('.mndw-pending__confirmation')?.textContent).toContain('Deny Network Tools?');

    target.querySelector<HTMLButtonElement>('.mndw-pending__confirm')?.click();
    expect(onDeny).toHaveBeenCalledWith('network-tools');

    target.querySelector<HTMLButtonElement>('.mndw-pending__cancel')?.click();
    expect(onCancelConfirm).toHaveBeenCalledOnce();

    void unmount(component);
  });

  it('renders an error for matching pending plugin', () => {
    const {component, target} = mountPendingApprovals({
      actionError: {name: 'network-tools', message: 'Approval failed'},
    });

    const error = target.querySelector('.mndw-alert--danger');

    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('Approval failed');

    void unmount(component);
  });
});
