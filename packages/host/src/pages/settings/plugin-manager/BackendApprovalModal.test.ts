import {afterEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {openApprovalModal} from './approval-modal.js';
import BackendApprovalModal from './BackendApprovalModal.svelte';

const {openHostModal} = vi.hoisted(() => ({openHostModal: vi.fn()}));

vi.mock('../../../services/overlay/host-overlay.js', () => ({openHostModal}));

const entry: PluginListEntry = {
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
    daemon: true,
    public: true,
  },
};

function mountModal(close = vi.fn()): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(BackendApprovalModal, {target, props: {entry, close}});

  flushSync();

  return {component, target};
}

describe('BackendApprovalModal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders declared backend capabilities and public marker', () => {
    const {component, target} = mountModal();

    expect(target.textContent).toContain('Network Tools (network-tools) declares a backend');
    expect(target.textContent).toContain('curl');
    expect(target.textContent).toContain('status: GET /api/status');
    expect(target.textContent).toContain('public: bypasses the session gate');

    void unmount(component);
  });

  it('returns approval result from action buttons', () => {
    const close = vi.fn();
    const {component, target} = mountModal(close);

    target.querySelector<HTMLButtonElement>('.mndw-approval__approve')?.click();
    expect(close).toHaveBeenLastCalledWith('approve');

    target.querySelector<HTMLButtonElement>('.mndw-approval__deny')?.click();
    expect(close).toHaveBeenLastCalledWith('deny');

    void unmount(component);
  });

  it('returns undefined without opening modal for an already aborted signal', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(openApprovalModal(entry, controller.signal)).resolves.toBeUndefined();
    expect(openHostModal).not.toHaveBeenCalled();
  });

  it('returns undefined and closes active modal when approval signal aborts', async () => {
    let resolveClosed: ((event: {result: 'approve' | 'deny' | undefined}) => void) | undefined;
    const closed = new Promise<{result: 'approve' | 'deny' | undefined}>((resolve) => {
      resolveClosed = resolve;
    });
    const close = vi.fn((result: 'approve' | 'deny' | undefined) => resolveClosed?.({result}));

    openHostModal.mockReturnValue({closed, close});

    const controller = new AbortController();
    const approval = openApprovalModal(entry, controller.signal);

    controller.abort();

    await expect(approval).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledWith(undefined);
  });

  it('removes abort listener after modal closes', async () => {
    let resolveClosed: ((event: {result: 'approve' | 'deny' | undefined}) => void) | undefined;
    const closed = new Promise<{result: 'approve' | 'deny' | undefined}>((resolve) => {
      resolveClosed = resolve;
    });
    const close = vi.fn((result: 'approve' | 'deny' | undefined) => resolveClosed?.({result}));

    openHostModal.mockReturnValue({closed, close});

    const controller = new AbortController();
    const approval = openApprovalModal(entry, controller.signal);

    close('approve');
    await expect(approval).resolves.toBe('approve');
    controller.abort();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
