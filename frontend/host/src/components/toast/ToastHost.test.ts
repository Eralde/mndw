// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

const mobileState = vi.hoisted(() => ({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));

vi.mock('../../layout/breakpoint.js', () => ({
  MOBILE_BREAKPOINT_PX: 720,
  mobileMediaQuery: vi.fn(() => mobileState),
}));

// hostT is only used for the dismiss/region labels here; echo the key back.
vi.mock('../../services/host-i18n.svelte.js', () => ({
  hostT: (key: string) => key,
}));

const {ToastStore} = await import('../../services/toast/toast.svelte.js');
const ToastHost = (await import('./ToastHost.svelte')).default;

describe('ToastHost', () => {
  let target: HTMLElement;
  let store: InstanceType<typeof ToastStore>;
  let app: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    mobileState.matches = false;
    target = document.createElement('div');
    document.body.appendChild(target);
    store = new ToastStore();
  });

  afterEach(() => {
    if (app) {
      void unmount(app);
      app = undefined;
    }

    store.clear();
    target.remove();
  });

  function render(): void {
    app = mount(ToastHost, {target, props: {store}});
    flushSync();
  }

  it('renders nothing when there are no toasts', () => {
    render();
    expect(target.querySelector('.mndw-toast-host')).toBeNull();
  });

  it('renders a toast with its message and severity class', () => {
    store.error('boom');
    render();

    const toastEl = target.querySelector('.mndw-toast');

    expect(toastEl?.textContent).toContain('boom');
    expect(toastEl?.classList.contains('mndw-alert--danger')).toBe(true);
    expect(toastEl?.getAttribute('role')).toBe('alert');
  });

  it('uses the status role for non-error toasts', () => {
    store.success('done');
    render();

    const toastEl = target.querySelector('.mndw-toast');

    expect(toastEl?.classList.contains('mndw-alert--success')).toBe(true);
    expect(toastEl?.getAttribute('role')).toBe('status');
  });

  it('removes a toast when its dismiss button is clicked', () => {
    store.error('boom');
    render();

    const button = target.querySelector<HTMLButtonElement>('.mndw-toast__dismiss');

    button?.click();
    flushSync();

    expect(target.querySelector('.mndw-toast')).toBeNull();
    expect(store.toasts).toHaveLength(0);
  });

  it('applies the mobile modifier and lowers the cap on a mobile viewport', () => {
    mobileState.matches = true;

    const setMax = vi.spyOn(store, 'setMaxToasts');

    store.info('hi');
    render();

    expect(target.querySelector('.mndw-toast-host--mobile')).not.toBeNull();
    expect(setMax).toHaveBeenCalledWith(3);
  });
});
