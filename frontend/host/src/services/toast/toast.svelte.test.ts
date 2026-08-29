import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_MAX_TOASTS, ToastStore, shouldDismissSwipe} from './toast.svelte.js';

describe('ToastStore', () => {
  let store: ToastStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ToastStore();
  });

  afterEach(() => {
    store.clear();
    vi.useRealTimers();
  });

  it('adds a toast and returns an incrementing id', () => {
    const first = store.show({message: 'a'});
    const second = store.show({message: 'b'});

    expect(second).toBeGreaterThan(first);
    expect(store.toasts.map((toast) => toast.message)).toEqual(['a', 'b']);
  });

  it('defaults info/success to auto-dismiss and errors to sticky', () => {
    store.success('done');
    store.error('boom');

    expect(store.toasts.map((toast) => toast.variant)).toEqual(['success', 'error']);

    vi.advanceTimersByTime(10000);

    // The success toast auto-dismisses; the error stays until dismissed.
    expect(store.toasts.map((toast) => toast.variant)).toEqual(['error']);
  });

  it('honors an explicit duration override', () => {
    const id = store.show({message: 'x', variant: 'error', duration: 1000});

    vi.advanceTimersByTime(999);
    expect(store.toasts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(store.toasts.find((toast) => toast.id === id)).toBeUndefined();
  });

  it('dismisses by id and cancels its timer', () => {
    const id = store.info('hello');

    store.dismiss(id);
    expect(store.toasts).toHaveLength(0);

    // Advancing past the default duration must not throw or resurrect anything.
    vi.advanceTimersByTime(10000);
    expect(store.toasts).toHaveLength(0);
  });

  it('caps the stack, evicting the oldest', () => {
    for (let i = 0; i < DEFAULT_MAX_TOASTS + 2; i++) {
      store.error(`e${i}`);
    }

    expect(store.toasts).toHaveLength(DEFAULT_MAX_TOASTS);
    expect(store.toasts[0].message).toBe('e2');
  });

  it('lowering the cap trims existing toasts immediately', () => {
    store.error('a');
    store.error('b');
    store.error('c');

    store.setMaxToasts(1);

    expect(store.toasts.map((toast) => toast.message)).toEqual(['c']);
  });

  it('clear removes everything and cancels timers', () => {
    store.info('a');
    store.error('b');

    store.clear();
    expect(store.toasts).toHaveLength(0);

    vi.advanceTimersByTime(10000);
    expect(store.toasts).toHaveLength(0);
  });
});

describe('shouldDismissSwipe', () => {
  it('dismisses when dragged past the distance ratio', () => {
    expect(shouldDismissSwipe(140, 300, 0)).toBe(true); // 140 / 300 ≈ 0.47 ≥ 0.35
  });

  it('keeps a short slow drag', () => {
    expect(shouldDismissSwipe(60, 300, 0.1)).toBe(false); // 0.2 ratio, slow
  });

  it('dismisses a fast flick even when the drag is short', () => {
    expect(shouldDismissSwipe(40, 300, 0.9)).toBe(true);
  });

  it('is direction-agnostic', () => {
    expect(shouldDismissSwipe(-140, 300, 0)).toBe(true);
  });

  it('never dismisses on a zero width', () => {
    expect(shouldDismissSwipe(999, 0, 5)).toBe(false);
  });
});
