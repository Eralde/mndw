import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {setLocale} from '../../../services/locale.service.js';
import PendingApprovals from './PendingApprovals.svelte';
import type {PluginRowState} from './reconcile.js';

const item: PluginListEntry = {
  type: 'page',
  name: 'network-tools',
  version: '1.0.0',
  label: 'Network Tools',
  entry: 'index.js',
  source: 'upload',
  approval: 'pending',
  enabled: false,
  depsStatus: 'ready',
  route: '/network-tools',
  backend: {
    routes: {status: {transport: 'http', method: 'GET', path: 'status'}},
  },
};

function mountPendingApprovals(props: Partial<{
  items: PluginListEntry[];
  confirmingName: string | null;
  rowStateFor: (name: string) => PluginRowState | undefined;
  onApprove: (name: string) => void;
  onDeny: (name: string) => void;
  onRequestConfirm: (name: string) => void;
  onCancelConfirm: () => void;
  onRefresh: () => void;
}> = {}): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(PendingApprovals, {
    target,
    props: {
      items: [item],
      confirmingName: null,
      rowStateFor: () => undefined,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
      onRequestConfirm: vi.fn(),
      onCancelConfirm: vi.fn(),
      onRefresh: vi.fn(),
      ...props,
    },
  });

  flushSync();

  return {component, target};
}

describe('PendingApprovals', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('approves a pending plugin', () => {
    const onApprove = vi.fn();
    const {component, target} = mountPendingApprovals({onApprove});

    expect(target.textContent).toContain('Pending approvals');
    expect(target.textContent).toContain('Network Tools');
    expect(target.textContent).toContain('network-tools');
    expect(target.textContent).toContain('status: GET status');

    target.querySelector<HTMLButtonElement>('.mndw-pending__approve')?.click();

    expect(onApprove).toHaveBeenCalledWith('network-tools');

    void unmount(component);
  });

  it('updates pending-approval labels after a locale commit', async () => {
    const {component, target} = mountPendingApprovals();

    try {
      expect(target.textContent).toContain('Pending approvals');
      expect(target.textContent).toContain('Deny');
      expect(target.textContent).toContain('Approve');

      await setLocale('ru');
      flushSync();

      expect(target.textContent).toContain('Ожидающие подтверждения');
      expect(target.textContent).toContain('Отклонить');
      expect(target.textContent).toContain('Подтвердить');
    } finally {
      await unmount(component);
      await setLocale('en');
    }
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
      rowStateFor: (name) =>
        name === 'network-tools'
          ? {state: 'error', message: 'Approval failed'}
          : undefined,
    });

    const error = target.querySelector('.mndw-alert--danger');

    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('Approval failed');

    void unmount(component);
  });
});
