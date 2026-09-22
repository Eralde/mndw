import {type FocusTrap, type FocusTrapOptions, createFocusTrap} from '@mndw/ui';
import type {Action} from 'svelte/action';

export interface FocusTrapActionOptions extends FocusTrapOptions {
  /** Default true. Toggling it through `update()` activates or deactivates the trap without remounting the node. */
  readonly enabled?: boolean;
}

/**
 * Contains focus in the node while `enabled` (default true); restores focus on release.
 * Options other than `enabled` are read when the trap activates; changing them while
 * active has no effect until the next activation.
 */
export const focusTrap: Action<HTMLElement, FocusTrapActionOptions | undefined> = (node, initial) => {
  let trap: FocusTrap | null = null;
  let enabled = false;
  let destroyed = false;
  let latestOptions = initial;

  const apply = (options: FocusTrapActionOptions | undefined): void => {
    latestOptions = options;
    enabled = options?.enabled ?? true;

    if (enabled && !trap) {
      if (node.hasAttribute('inert')) {
        // Svelte may update the action before removing `inert` from the same node.
        queueMicrotask(() => {
          if (enabled && !destroyed && !trap && !node.hasAttribute('inert')) {
            trap = createFocusTrap(node, latestOptions);
          }
        });
      } else {
        trap = createFocusTrap(node, latestOptions);
      }
    } else if (!enabled && trap) {
      trap.deactivate();
      trap = null;
    }
  };

  apply(initial);

  return {
    update: apply,
    destroy(): void {
      destroyed = true;
      trap?.deactivate();
      trap = null;
    },
  };
};
