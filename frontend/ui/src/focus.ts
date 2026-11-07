export interface FocusTrapOptions {
  /** Element to focus on activation when focus is not already inside. Defaults to the first tabbable. */
  readonly initialFocus?: () => HTMLElement | null;
  /** Refocus the element that was focused at activation when deactivating. Default true. */
  readonly restoreFocus?: boolean;
  /** Return true to let focus sit outside the container (for example, a popover stacked above). */
  readonly allowFocus?: (target: Node) => boolean;
}

export interface FocusTrap {
  deactivate(): void;
}

interface ActiveTrap {
  readonly container: HTMLElement;
  readonly options: FocusTrapOptions;
  /** Last element focused inside the container; escaped focus returns here. */
  lastFocused: HTMLElement | null;
}

const NATURALLY_FOCUSABLE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'IFRAME']);

// Only the top entry handles events; lower entries are paused, not removed, so a
// nested trap's deactivation resumes its parent without re-registration.
const trapStack: ActiveTrap[] = [];

export function deepActiveElement(): Element | null {
  let element = document.activeElement;

  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }

  return element;
}

/** True when `node` is `container` or sits beneath it, crossing open shadow boundaries upward. */
export function composedContains(container: Node, node: Node | null): boolean {
  let current: Node | null = node;

  while (current) {
    if (current === container) {
      return true;
    }

    current = current instanceof ShadowRoot ? current.host : current.parentNode;
  }

  return false;
}

/** Focus `container`'s active control again on animation frames until focus lands or the owner changes. */
export function focusWithinWithRetry(
  container: HTMLElement,
  focus: () => void,
  isCurrent: () => boolean,
  onFocus: () => void,
  maxFrames = 5,
): () => void {
  let cancelled = false;
  let frameId: number | null = null;
  let framesRemaining = maxFrames;

  const cancel = (): void => {
    cancelled = true;

    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  const attempt = (): void => {
    frameId = null;

    if (cancelled || !isCurrent()) {
      cancel();

      return;
    }

    focus();

    if (cancelled || !isCurrent()) {
      cancel();

      return;
    }

    if (composedContains(container, deepActiveElement())) {
      onFocus();
      cancel();

      return;
    }

    if (framesRemaining <= 0) {
      cancel();

      return;
    }

    framesRemaining -= 1;
    frameId = requestAnimationFrame(attempt);
  };

  attempt();

  return cancel;
}

// Deterministic across browsers and happy-dom: derive the tab index from markup
// rather than the `tabIndex` property, whose defaults differ between environments.
function isEditingHost(element: HTMLElement): boolean {
  const value = element.getAttribute('contenteditable')?.toLowerCase();

  if (value !== '' && value !== 'true' && value !== 'plaintext-only') {
    return false;
  }

  let parent = element.parentElement;

  while (parent) {
    const parentValue = parent.getAttribute('contenteditable')?.toLowerCase();

    if (parentValue === '' || parentValue === 'true' || parentValue === 'plaintext-only') {
      return false;
    }

    if (parentValue === 'false') {
      return true;
    }

    parent = parent.parentElement;
  }

  return true;
}

function tabIndexOf(element: HTMLElement): number {
  const attribute = element.getAttribute('tabindex');

  if (attribute !== null) {
    const parsed = Number.parseInt(attribute, 10);

    return Number.isNaN(parsed) ? -1 : parsed;
  }

  if (element.tagName === 'A') {
    return element.hasAttribute('href') ? 0 : -1;
  }

  if (isEditingHost(element)) {
    return 0;
  }

  return NATURALLY_FOCUSABLE.has(element.tagName) ? 0 : -1;
}

function isDisabled(element: HTMLElement): boolean {
  if (element.matches(':disabled')) {
    return true;
  }

  let parent = element.parentElement;

  while (parent) {
    if (parent instanceof HTMLFieldSetElement && parent.disabled) {
      const firstLegend = [...parent.children].find((child) => child instanceof HTMLLegendElement);

      if (!firstLegend?.contains(element)) {
        return true;
      }
    }

    parent = parent.parentElement;
  }

  return false;
}

function isTabbable(element: HTMLElement): boolean {
  if (tabIndexOf(element) < 0) {
    return false;
  }

  if (isDisabled(element)) {
    return false;
  }

  if (element instanceof HTMLInputElement && element.type === 'hidden') {
    return false;
  }

  return typeof element.checkVisibility === 'function' ? element.checkVisibility() : true;
}

// Composed (rendered) order: a shadow host contributes its shadow tree, and a slot
// contributes its assigned elements (or its fallback children when nothing is assigned).
function composedChildren(node: Node): Element[] {
  if (node instanceof HTMLSlotElement) {
    const assigned = node.assignedNodes({flatten: true});

    return assigned.length > 0
      ? assigned.filter((assignedNode): assignedNode is Element => assignedNode instanceof Element)
      : [...node.children];
  }

  if (node instanceof Element && node.shadowRoot) {
    return [...node.shadowRoot.children];
  }

  if (node instanceof Element || node instanceof ShadowRoot) {
    return [...node.children];
  }

  return [];
}

function collectTabbables(node: Node, out: HTMLElement[]): void {
  for (const child of composedChildren(node)) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }

    if (child.hidden || child.hasAttribute('inert')) {
      continue;
    }

    if (isTabbable(child)) {
      out.push(child);
    }

    collectTabbables(child, out);
  }
}

/** Keyboard-reachable elements inside `container`, in composed tree order. */
export function tabbableElements(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];

  collectTabbables(container, out);

  return out;
}

function focusableContainer(container: HTMLElement): HTMLElement {
  if (!container.hasAttribute('tabindex')) {
    container.setAttribute('tabindex', '-1');
  }

  return container;
}

function focusFirst(trap: ActiveTrap): void {
  const [first] = tabbableElements(trap.container);

  (first ?? focusableContainer(trap.container)).focus();
}

function onKeydown(event: KeyboardEvent): void {
  const trap = trapStack.at(-1);

  if (!trap || event.key !== 'Tab' || event.defaultPrevented) {
    return;
  }

  const active = deepActiveElement();

  if (active && !composedContains(trap.container, active) && trap.options.allowFocus?.(active) === true) {
    return;
  }

  const tabbables = tabbableElements(trap.container);

  event.preventDefault();

  if (tabbables.length === 0) {
    focusableContainer(trap.container).focus();

    return;
  }

  const index = active instanceof HTMLElement ? tabbables.indexOf(active) : -1;
  const count = tabbables.length;
  const next = index === -1
    ? (event.shiftKey ? count - 1 : 0)
    : (index + (event.shiftKey ? -1 : 1) + count) % count;

  tabbables[next]?.focus();
}

function onFocusIn(event: FocusEvent): void {
  const trap = trapStack.at(-1);

  if (!trap) {
    return;
  }

  const [target] = event.composedPath();

  if (!(target instanceof Node)) {
    return;
  }

  if (composedContains(trap.container, target)) {
    trap.lastFocused = target instanceof HTMLElement ? target : trap.lastFocused;

    return;
  }

  if (trap.options.allowFocus?.(target) === true) {
    return;
  }

  const last = trap.lastFocused;

  if (last?.isConnected === true && composedContains(trap.container, last)) {
    last.focus();
  } else {
    focusFirst(trap);
  }
}

/**
 * Contains keyboard focus inside `container` until `deactivate()`. Tab and Shift+Tab
 * cycle through {@link tabbableElements}; focus that escapes (click, script) returns to
 * the last element focused inside, or the first tabbable if that is gone. The keydown listener runs in the bubble phase and skips handled events, so
 * components that own Tab (such as the select panel's dismiss) keep working.
 */
export function createFocusTrap(container: HTMLElement, options: FocusTrapOptions = {}): FocusTrap {
  const previous = deepActiveElement();
  const trap: ActiveTrap = {container, options, lastFocused: null};

  if (trapStack.length === 0) {
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('focusin', onFocusIn, true);
  }

  trapStack.push(trap);

  const active = deepActiveElement();

  if (active instanceof HTMLElement && composedContains(container, active)) {
    trap.lastFocused = active;
  }

  if (!active || !composedContains(container, active)) {
    const initial = options.initialFocus?.() ?? null;

    if (initial) {
      initial.focus();
    } else {
      focusFirst(trap);
    }
  }

  let isActive = true;

  return {
    deactivate(): void {
      if (!isActive) {
        return;
      }

      isActive = false;

      const index = trapStack.indexOf(trap);

      if (index !== -1) {
        trapStack.splice(index, 1);
      }

      if (trapStack.length === 0) {
        document.removeEventListener('keydown', onKeydown);
        document.removeEventListener('focusin', onFocusIn, true);
      }

      if (options.restoreFocus !== false && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    },
  };
}
