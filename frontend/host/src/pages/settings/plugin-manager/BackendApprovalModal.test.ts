// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {setLocale} from '../../../services/locale.service.js';
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
  source: 'upload',
  approval: 'pending',
  enabled: false,
  depsStatus: 'ready',
  route: '/network-tools',
  backend: {
    routes: {status: {transport: 'http', method: 'GET', path: 'status'}},
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
  beforeAll(() => {
    defineMndwUi();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders declared backend routes', () => {
    const {component, target} = mountModal();

    expect(target.textContent).toContain('Network Tools (network-tools) declares a backend');
    expect(target.textContent).toContain('status: GET status');

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

  it('localizes the approval modal title', async () => {
    const close = vi.fn();

    openHostModal.mockReturnValue({
      closed: Promise.resolve({result: undefined}),
      close,
    });

    try {
      await openApprovalModal(entry);
      expect(openHostModal).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({title: 'Approve backend for Network Tools'}),
      );

      await setLocale('ru');
      await openApprovalModal(entry);
      expect(openHostModal).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({title: 'Подтвердить серверную часть для Network Tools'}),
      );
    } finally {
      await setLocale('en');
      openHostModal.mockReset();
    }
  });

  it('updates modal labels after a locale commit', async () => {
    const {component, target} = mountModal();
    const text = (): string => target.textContent?.replace(/\s+/g, ' ').trim() ?? '';

    try {
      expect(text()).toContain('declares a backend. Review its capabilities before approving.');
      expect(text()).toContain('Deny');
      expect(text()).toContain('Approve');

      await setLocale('ru');
      flushSync();

      expect(text()).toContain('объявляет серверную часть. Проверьте её возможности перед подтверждением.');
      expect(text()).toContain('Отклонить');
      expect(text()).toContain('Подтвердить');
    } finally {
      await unmount(component);
      await setLocale('en');
    }
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
