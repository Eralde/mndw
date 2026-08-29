// Host-internal toast notifications. A small imperative service (queue, auto-dismiss
// timers, stacking policy) plus a reactive store the ToastHost component renders. This
// is the orchestration layer above the shared `mndw-alert` style kit — the same split
// the overlay system uses (host owns orchestration; @mndw/ui owns the visual kit).
//
// It is deliberately host-only and l10n-agnostic: callers pass already-translated
// strings, exactly as the previous in-panel status bar did. Plugin/SDK exposure is a
// separate, later phase.

import {SvelteMap} from 'svelte/reactivity';

export type ToastVariant = 'success' | 'info' | 'error';

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /**
   * Milliseconds before auto-dismiss. `0` means sticky (dismissed only by the user).
   * Omitted falls back to the per-variant default: errors are sticky, the rest
   * auto-dismiss — an error message (e.g. a dependency conflict) must stay readable.
   */
  duration?: number;
}

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly variant: ToastVariant;
  readonly duration: number;
}

const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  error: 0,
};

/** Default cap on concurrently shown toasts; the ToastHost lowers it on mobile. */
export const DEFAULT_MAX_TOASTS = 4;

// Swipe-to-dismiss thresholds (mobile). A horizontal drag past either the distance
// ratio (of the toast width) or the flick velocity dismisses; otherwise it snaps back.
const SWIPE_DISTANCE_RATIO = 0.35;
const SWIPE_VELOCITY_THRESHOLD = 0.5; // px per ms

/**
 * Pure decision for swipe-to-dismiss, extracted so it is unit-testable without a DOM.
 * `dx` is the horizontal drag distance (px), `width` the toast width (px), `velocity`
 * the release velocity (px/ms). Either a far-enough drag or a fast-enough flick wins.
 */
export function shouldDismissSwipe(dx: number, width: number, velocity: number): boolean {
  if (width <= 0) {
    return false;
  }

  return Math.abs(dx) >= width * SWIPE_DISTANCE_RATIO || Math.abs(velocity) >= SWIPE_VELOCITY_THRESHOLD;
}

export class ToastStore {
  public toasts = $state<Toast[]>([]);

  private nextId = 1;
  private maxToasts = DEFAULT_MAX_TOASTS;
  // Not reactive state, but SvelteMap keeps this `.svelte.ts` module within the
  // repo's reactivity lint rule; the timer bookkeeping is otherwise plain.
  private readonly timers = new SvelteMap<number, ReturnType<typeof setTimeout>>();

  /** Enqueue a toast and return its id. Oldest toasts are evicted past the cap. */
  public show(options: ToastOptions): number {
    const variant = options.variant ?? 'info';
    const duration = options.duration ?? DEFAULT_DURATIONS[variant];
    const id = this.nextId++;

    this.toasts.push({id, message: options.message, variant, duration});
    this.enforceCap();

    if (duration > 0) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), duration));
    }

    return id;
  }

  public success(message: string, options?: Omit<ToastOptions, 'message' | 'variant'>): number {
    return this.show({...options, message, variant: 'success'});
  }

  public info(message: string, options?: Omit<ToastOptions, 'message' | 'variant'>): number {
    return this.show({...options, message, variant: 'info'});
  }

  public error(message: string, options?: Omit<ToastOptions, 'message' | 'variant'>): number {
    return this.show({...options, message, variant: 'error'});
  }

  /** Remove a toast by id (user dismiss or auto-dismiss). No-op if already gone. */
  public dismiss(id: number): void {
    this.clearTimer(id);

    const index = this.toasts.findIndex((toast) => toast.id === id);

    if (index !== -1) {
      this.toasts.splice(index, 1);
    }
  }

  /** Adjust the concurrent cap (the ToastHost sets a lower value on mobile). */
  public setMaxToasts(max: number): void {
    this.maxToasts = Math.max(1, Math.trunc(max));
    this.enforceCap();
  }

  /** Remove every toast and cancel pending timers (used on teardown and in tests). */
  public clear(): void {
    for (const id of this.timers.keys()) {
      this.clearTimer(id);
    }

    this.toasts = [];
  }

  private enforceCap(): void {
    while (this.toasts.length > this.maxToasts) {
      const evicted = this.toasts.shift();

      if (evicted !== undefined) {
        this.clearTimer(evicted.id);
      }
    }
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);

    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}

/** Shared host toast store; the ToastHost renders it and pages call its methods. */
export const toast = new ToastStore();
