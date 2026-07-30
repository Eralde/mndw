import type {FormAssociatedController} from './form-associated.js';

/**
 * The native element a text control wraps. Both are focusable, both compute their own constraint
 * validity, and both are what the accessibility tree actually reports.
 */
export type TextControlElement = HTMLInputElement | HTMLTextAreaElement;

interface TextControlHost extends HTMLElement {
  requestUpdate: () => void;
}

/**
 * Naming inputs a text control reads off its own host. Changing any of them re-resolves what the
 * inner element announces, which is why they are observed rather than read once.
 */
const NAMING_ATTRIBUTES = ['id', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-invalid', 'aria-required'];

const TOKEN_SEPARATOR = /\s+/u;
const WHITESPACE_RUN = /\s+/gu;

/** ARIA reflection tells us whether the engine knows `aria-description` at all. */
const SUPPORTS_ARIA_DESCRIPTION = 'ariaDescription' in Element.prototype;

/** `instanceof Document` is unreliable across DOM implementations; probe the capability instead. */
export function searchRoot(node: Node): Document | ShadowRoot | null {
  const root = node.getRootNode() as Document | ShadowRoot;

  return typeof root.querySelectorAll === 'function' ? root : null;
}

function elementById(root: Document | ShadowRoot, id: string): Element | null {
  if (typeof root.getElementById === 'function') {
    return root.getElementById(id);
  }

  return root.querySelector(`[id="${id}"]`);
}

/** An empty optional never reaches the DOM as an empty attribute. */
export function setOrRemove(target: Element, attribute: string, value: string): void {
  if (value === '') {
    target.removeAttribute(attribute);

    return;
  }

  if (target.getAttribute(attribute) !== value) {
    target.setAttribute(attribute, value);
  }
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * `textContent` for everything the accessibility tree would read, minus `aria-hidden` subtrees —
 * `<mndw-field>`'s required marker is one, and raw `textContent` would announce its `*`. Not
 * `innerText`: CSS must not decide, so a label styled `display: none` still contributes.
 */
export function accessibleTextFrom(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  if ((node as Element).getAttribute('aria-hidden') === 'true') {
    return '';
  }

  let text = '';

  for (const child of node.childNodes) {
    text += accessibleTextFrom(child);
  }

  return text;
}

/** Accessible-name computation joins every label in DOM order, not just the first. */
export function labelTextFrom(labels: readonly Element[]): string {
  return labels
    .map((label) => normalizeText(accessibleTextFrom(label)))
    .filter((text) => text !== '')
    .join(' ');
}

/** Missing ids are skipped silently: a stale IDREF is common mid-render and must not be announced. */
export function idRefsTextFrom(root: Document | ShadowRoot | null, idrefs: string | null): string {
  if (!root || idrefs === null) {
    return '';
  }

  return idrefs
    .split(TOKEN_SEPARATOR)
    .filter((id) => id !== '')
    .map((id) => elementById(root, id))
    .filter((target): target is Element => target !== null)
    .map((target) => normalizeText(accessibleTextFrom(target)))
    .filter((text) => text !== '')
    .join(' ');
}

/**
 * Where `aria-description` is unsupported the description is folded into the forwarded name — safe
 * only because the inner element carries no competing `aria-labelledby` and the control owns it.
 */
export function forwardedLabel(
  name: string,
  description: string,
  supportsAriaDescription: boolean = SUPPORTS_ARIA_DESCRIPTION,
): string {
  if (supportsAriaDescription) {
    return name;
  }

  return [name, description].filter((text) => text !== '').join(' ');
}

/** The browser computes these on the inner element; the host mirrors rather than duplicates them. */
export function validityFlagsFrom(validity: ValidityState): ValidityStateFlags {
  return {
    badInput: validity.badInput,
    patternMismatch: validity.patternMismatch,
    rangeOverflow: validity.rangeOverflow,
    rangeUnderflow: validity.rangeUnderflow,
    stepMismatch: validity.stepMismatch,
    tooLong: validity.tooLong,
    tooShort: validity.tooShort,
    typeMismatch: validity.typeMismatch,
    valueMissing: validity.valueMissing,
  };
}

export interface TextAnnouncementOptions<Host extends HTMLElement> {
  formState: FormAssociatedController<Host>;
  isInvalid: () => boolean;
}

/**
 * Name, description, and invalid state have to cross the shadow boundary as strings, because the
 * element a screen reader reports is the inner one and IDREFs do not resolve into another tree.
 * Shared by every text-family control; what stays per-control is the inner element and its editing
 * behavior.
 */
export class TextAnnouncementController<Host extends TextControlHost> {
  private readonly host: Host;
  private readonly options: TextAnnouncementOptions<Host>;
  private readonly hostObserver: MutationObserver;
  private readonly referenceObserver: MutationObserver;

  constructor(host: Host, options: TextAnnouncementOptions<Host>) {
    this.host = host;
    this.options = options;
    this.hostObserver = new MutationObserver(this.onMutation);
    this.referenceObserver = new MutationObserver(this.onMutation);
  }

  public connect(): void {
    this.hostObserver.observe(this.host, {attributes: true, attributeFilter: NAMING_ATTRIBUTES});
  }

  public disconnect(): void {
    this.hostObserver.disconnect();
    this.referenceObserver.disconnect();
  }

  /** A consumer's `aria-required` announces the same thing the property does, so it counts too. */
  public get hasAriaRequired(): boolean {
    return this.host.getAttribute('aria-required') === 'true';
  }

  public get labels(): HTMLLabelElement[] {
    const labels = this.options.formState.labels;

    if (labels.length > 0) {
      return labels;
    }

    // Form-associated custom elements are labelable by specification, but not every DOM
    // implementation resolves `internals.labels` for them; fall back to the `for` association.
    const root = searchRoot(this.host);

    if (!root || this.host.id === '') {
      return [];
    }

    return [...root.querySelectorAll('label')].filter((label) => label.htmlFor === this.host.id);
  }

  public sync(inner: TextControlElement): void {
    const labels = this.labels;
    const root = searchRoot(this.host);
    const name = this.resolveName(labels, root);
    const description = idRefsTextFrom(root, this.host.getAttribute('aria-describedby'));

    setOrRemove(inner, 'aria-label', forwardedLabel(name, description));
    setOrRemove(inner, 'aria-description', description);
    setOrRemove(inner, 'aria-invalid', this.announcedInvalid() ? 'true' : '');
    this.observeReferences(labels, root);
  }

  private resolveName(labels: readonly Element[], root: Document | ShadowRoot | null): string {
    if (this.host.hasAttribute('aria-labelledby')) {
      return idRefsTextFrom(root, this.host.getAttribute('aria-labelledby'));
    }

    if (this.host.hasAttribute('aria-label')) {
      return normalizeText(this.host.getAttribute('aria-label'));
    }

    return labelTextFrom(labels);
  }

  /** Highest first: the host attribute a consumer or `<mndw-field>` set, the property, then validity. */
  private announcedInvalid(): boolean {
    const announced = this.host.getAttribute('aria-invalid');

    if (announced !== null) {
      return announced !== 'false';
    }

    if (this.options.isInvalid()) {
      return true;
    }

    return this.options.formState.internals?.validity.valid === false;
  }

  /** The observed set is exactly what the last resolve read, so it is rebuilt on every resolve. */
  private observeReferences(labels: readonly Element[], root: Document | ShadowRoot | null): void {
    this.referenceObserver.disconnect();

    const targets = new Set<Node>(labels);

    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      const idrefs = this.host.getAttribute(attribute);

      if (idrefs === null || !root) {
        continue;
      }

      for (const id of idrefs.split(TOKEN_SEPARATOR).filter((token) => token !== '')) {
        const target = elementById(root, id);

        if (target) {
          targets.add(target);
        }
      }
    }

    for (const target of targets) {
      this.referenceObserver.observe(target, {childList: true, subtree: true, characterData: true});
    }
  }

  private readonly onMutation = (): void => {
    this.host.requestUpdate();
  };
}

/**
 * "On commit" timing, shared by every text control: a change is only announced when the value
 * differs from what it was when the control gained focus, so tabbing through an untouched form
 * fires nothing. What differs per control is which gestures commit — blur for both, Enter for
 * `<mndw-input>` only, since Enter inserts a newline in a textarea.
 */
export class CommitTracker {
  private readonly onCommit: (value: string) => void;
  private baseline: string | null = null;
  private fromUserInput = false;

  constructor(onCommit: (value: string) => void) {
    this.onCommit = onCommit;
  }

  public captureBaseline(value: string): void {
    this.baseline = value;
  }

  public releaseBaseline(): void {
    this.baseline = null;
  }

  public markUserInput(): void {
    this.fromUserInput = true;
  }

  /**
   * A programmatic write while focused replaces the baseline, so a later blur does not synthesize a
   * change the user never made; a write from the user-input handler leaves the baseline alone.
   */
  public syncValue(value: string): void {
    if (this.fromUserInput) {
      this.fromUserInput = false;

      return;
    }

    if (this.baseline !== null) {
      this.baseline = value;
    }
  }

  public commit(value: string): void {
    if (this.baseline === null || this.baseline === value) {
      return;
    }

    this.baseline = value;
    this.onCommit(value);
  }
}
