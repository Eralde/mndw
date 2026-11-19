// Host-internal toast notifications. A small imperative service (queue, auto-dismiss
// timers, stacking policy) plus a reactive store the ToastHost component renders. This
// is the orchestration layer above the shared `mndw-alert` style kit — the same split
// the overlay system uses (host owns orchestration; @mndw/ui owns the visual kit).
//
// It is deliberately host-only. Most callers pass translated strings; optional
// resolvers keep selected notification text current with reactive host state.

import {SvelteMap} from 'svelte/reactivity';

export type ToastVariant = 'success' | 'info' | 'error';

export interface ToastAction {
  label: string;
  getLabel?: () => string;
  onAction: () => void | Promise<void>;
  busy?: boolean;
}

export interface ToastOptions {
  message: string;
  getMessage?: () => string;
  variant?: ToastVariant;
  key?: string;
  action?: ToastAction;
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
  readonly key?: string;
  readonly action?: ToastAction;
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

function createStoredAction(action: ToastAction): ToastAction {
  return {
    get label(): string {
      return action.getLabel?.() ?? action.label;
    },
    onAction: action.onAction,
    ...(action.busy === undefined ? {} : {busy: action.busy}),
  };
}

function createStoredToast(
  id: number,
  options: ToastOptions,
  variant: ToastVariant,
  duration: number,
): Toast {
  return {
    id,
    get message(): string {
      return options.getMessage?.() ?? options.message;
    },
    variant,
    duration,
    ...(options.key === undefined ? {} : {key: options.key}),
    ...(options.action === undefined ? {} : {action: createStoredAction(options.action)}),
  };
}

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
    const keyedIndex = options.key === undefined
      ? -1
      : this.toasts.findIndex((toast) => toast.key === options.key);

    if (keyedIndex !== -1) {
      const current = this.toasts[keyedIndex];

      if (current === undefined) {
        return this.add(options, variant, duration);
      }

      this.clearTimer(current.id);
      this.toasts[keyedIndex] = createStoredToast(current.id, options, variant, duration);
      this.startTimer(current.id, duration);

      return current.id;
    }

    return this.add(options, variant, duration);
  }

  private add(options: ToastOptions, variant: ToastVariant, duration: number): number {
    const id = this.nextId++;

    this.toasts.push(createStoredToast(id, options, variant, duration));
    this.enforceCap();
    this.startTimer(id, duration);

    return id;
  }

  private startTimer(id: number, duration: number): void {
    if (duration > 0) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), duration));
    }
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

  /** Remove the currently displayed toast with this key, if any. */
  public dismissKey(key: string): void {
    const current = this.toasts.find((toast) => toast.key === key);

    if (current !== undefined) {
      this.dismiss(current.id);
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
