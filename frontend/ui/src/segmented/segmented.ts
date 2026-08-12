import {LitElement, type PropertyDeclarations, type PropertyValues, type TemplateResult, css, html} from 'lit';
import {MNDW_LABEL_CHANGE_EVENT, type MndwLabelSource} from '../field/field.js';
import {FormAssociatedController} from '../forms/form-associated.js';
import {getMndwUiText, subscribeMndwUiLocale} from '../i18n.js';
import {focusRing, hostTypography} from '../styles/base.js';
import {MNDW_SEGMENT_CHANGE_EVENT, MNDW_SEGMENT_TAG, type MndwSegment} from './segment.js';

export const MNDW_SEGMENTED_TAG = 'mndw-segmented';

export interface MndwSegmentedChangeDetail {
  value: string;
}

/** Attributes the group writes onto its segments, and therefore the only ones it may remove. */
const OWNED_SEGMENT_ATTRIBUTES = ['role', 'aria-checked', 'aria-disabled', 'tabindex'];

const FORWARD_KEYS = ['ArrowRight', 'ArrowDown'];
const BACKWARD_KEYS = ['ArrowLeft', 'ArrowUp'];
const ACTIVATION_KEYS = [' ', 'Enter'];

export class MndwSegmented extends LitElement {
  public static readonly formAssociated = true;

  /** A non-empty `label` is the accessible name; its children are segments, never labels. */
  public static readonly mndwLabelSource: MndwLabelSource = 'label-property';

  public static readonly properties: PropertyDeclarations = {
    value: {type: String},
    label: {type: String},
    disabled: {type: Boolean, reflect: true},
    required: {type: Boolean, reflect: true},
    invalid: {type: Boolean, reflect: true},
    name: {type: String, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-flex;
    }

    :host([disabled]) {
      pointer-events: none;
      opacity: 0.5;
    }

    [part='group'] {
      display: inline-flex;
      gap: var(--mndw-space-1);
      padding: var(--mndw-space-1);
      border: var(--mndw-border-w) solid var(--mndw-border);
      border-radius: var(--mndw-radius-md);
      background: var(--mndw-surface);
    }

    ::slotted(mndw-segment:focus-visible) {
      ${focusRing}

      border-radius: var(--mndw-radius-sm);
    }
  `;

  declare public value: string;
  declare public label: string;
  declare public disabled: boolean;
  declare public required: boolean;
  declare public invalid: boolean;
  declare public name: string;

  private readonly formState = new FormAssociatedController(this, {
    isExplicitlyDisabled: () => this.disabled,
    onReset: () => this.resetForm(),
    onStateRestore: (state) => this.restoreFormState(state),
    onDisabledChange: () => {
      this.requestUpdate();
    },
  });
  private owned: MndwSegment[] = [];
  private ownsAriaLabel = false;
  private ownedAriaLabel: string | null = null;
  private localeUnsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.value = '';
    this.label = '';
    this.disabled = false;
    this.required = false;
    this.invalid = false;
    this.name = '';
    this.addEventListener('click', this.onClick);
    this.addEventListener('keydown', this.onKeyDown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.localeUnsubscribe = subscribeMndwUiLocale(this.onLocaleChange);
    this.formState.captureInitialAttributes(['value']);
    this.addEventListener(MNDW_SEGMENT_CHANGE_EVENT, this.onSegmentChange);
  }

  public override disconnectedCallback(): void {
    this.localeUnsubscribe?.();
    this.localeUnsubscribe = null;
    super.disconnectedCallback();
    this.removeEventListener(MNDW_SEGMENT_CHANGE_EVENT, this.onSegmentChange);
    this.releaseSegments(this.owned);
    this.owned = [];
  }

  public formDisabledCallback(disabled: boolean): void {
    this.formState.formDisabledCallback(disabled);
  }

  public formResetCallback(): void {
    this.formState.formResetCallback();
  }

  public formStateRestoreCallback(state: string | File | FormData | null, mode: 'autocomplete' | 'restore'): void {
    this.formState.formStateRestoreCallback(state, mode);
  }

  protected override render(): TemplateResult {
    return html`
      <div part="group">
        <slot @slotchange=${this.onSlotChange}></slot>
      </div>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    const selected = this.syncSegments();

    this.syncHost(selected);
    this.syncFormState(selected);

    // A label source that changes after mount would leave a wrapping field's suppression stale.
    if (changed.has('label') && changed.get('label') !== undefined) {
      this.dispatchEvent(new Event(MNDW_LABEL_CHANGE_EVENT, {bubbles: true, composed: true}));
    }
  }

  /** A segment with no value is ignored rather than treated as an error. */
  private segments(): MndwSegment[] {
    return [...this.children].filter((child): child is MndwSegment =>
      child.localName === MNDW_SEGMENT_TAG && (child as MndwSegment).value !== ''
    );
  }

  private isSegmentDisabled(segment: MndwSegment): boolean {
    return segment.disabled || this.formState.effectiveDisabled;
  }

  private syncSegments(): MndwSegment | null {
    const segments = this.segments();
    const selected = segments.find((segment) => segment.value === this.value) ?? null;
    const tabStop = selected && !this.isSegmentDisabled(selected)
      ? selected
      : segments.find((segment) => !this.isSegmentDisabled(segment)) ?? null;

    this.releaseSegments(this.owned.filter((segment) => !segments.includes(segment)));

    for (const segment of segments) {
      segment.setAttribute('role', 'radio');
      segment.setAttribute('aria-checked', String(segment === selected));
      segment.setAttribute('aria-disabled', String(this.isSegmentDisabled(segment)));
      segment.setAttribute('tabindex', segment === tabStop && !this.formState.effectiveDisabled ? '0' : '-1');
    }

    this.owned = segments;

    return selected;
  }

  private releaseSegments(segments: readonly MndwSegment[]): void {
    for (const segment of segments) {
      for (const attribute of OWNED_SEGMENT_ATTRIBUTES) {
        segment.removeAttribute(attribute);
      }
    }
  }

  private syncHost(selected: MndwSegment | null): void {
    const effectiveDisabled = this.formState.effectiveDisabled;
    const invalid = this.invalid || (this.required && !selected);

    this.setAttribute('role', 'radiogroup');
    this.setAttribute('aria-disabled', String(effectiveDisabled));
    this.setAttribute('aria-required', String(this.required));
    this.setAttribute('aria-invalid', String(invalid));
    // Never a tab stop — the checked or first enabled segment is — but focusable so that
    // `form.reportValidity()` has an anchor.
    this.tabIndex = -1;
    this.syncAccessibleLabel();

    const internals = this.formState.internals;

    if (!internals) {
      return;
    }

    internals.role = 'radiogroup';
    internals.ariaLabel = this.label || null;
    internals.ariaDisabled = String(effectiveDisabled);
    internals.ariaRequired = String(this.required);
    internals.ariaInvalid = String(invalid);
  }

  private syncAccessibleLabel(): void {
    const current = this.getAttribute('aria-label');

    if (this.ownsAriaLabel && current !== this.ownedAriaLabel) {
      this.ownsAriaLabel = false;
      this.ownedAriaLabel = null;
    }

    if (this.label) {
      if (this.ownsAriaLabel || current === null) {
        this.setAttribute('aria-label', this.label);
        this.ownsAriaLabel = true;
        this.ownedAriaLabel = this.label;
      }

      return;
    }

    if (this.ownsAriaLabel) {
      this.removeAttribute('aria-label');
      this.ownsAriaLabel = false;
      this.ownedAriaLabel = null;
    }
  }

  private syncFormState(selected: MndwSegment | null): void {
    this.formState.setFormValue(selected ? selected.value : null, this.value);

    if (this.required && !selected) {
      this.formState.setValidity({valueMissing: true}, getMndwUiText('segmented.validation.required'));
    } else {
      this.formState.clearValidity();
    }
  }

  private readonly onSlotChange = (): void => {
    this.requestUpdate();
  };

  private readonly onLocaleChange = (): void => {
    this.requestUpdate();
  };

  private readonly onSegmentChange = (): void => {
    this.requestUpdate();
  };

  private readonly onClick = (event: Event): void => {
    const segment = this.segmentFrom(event.target);

    if (!segment || this.isSegmentDisabled(segment)) {
      return;
    }

    this.activate(segment);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.formState.effectiveDisabled) {
      return;
    }

    const focusable = this.segments().filter((segment) => !this.isSegmentDisabled(segment));

    if (focusable.length === 0) {
      return;
    }

    const next = this.nextSegment(event.key, focusable, this.segmentFrom(event.target));

    if (!next) {
      return;
    }

    event.preventDefault();
    this.activate(next);
  };

  private nextSegment(key: string, focusable: MndwSegment[], from: MndwSegment | null): MndwSegment | null {
    const current = from ? focusable.indexOf(from) : -1;
    const last = focusable.length - 1;

    if (FORWARD_KEYS.includes(key)) {
      return focusable[current < 0 || current === last ? 0 : current + 1];
    }

    if (BACKWARD_KEYS.includes(key)) {
      return focusable[current <= 0 ? last : current - 1];
    }

    if (key === 'Home') {
      return focusable[0];
    }

    if (key === 'End') {
      return focusable[last];
    }

    if (ACTIVATION_KEYS.includes(key) && current >= 0) {
      return focusable[current];
    }

    return null;
  }

  private segmentFrom(target: EventTarget | null): MndwSegment | null {
    const segment = target instanceof Element ? target.closest<MndwSegment>(MNDW_SEGMENT_TAG) : null;

    return segment?.parentElement === this ? segment : null;
  }

  private activate(segment: MndwSegment): void {
    const changed = this.value !== segment.value;

    this.value = segment.value;
    segment.focus();

    if (changed) {
      this.dispatchEvent(
        new CustomEvent<MndwSegmentedChangeDetail>('mndwchange', {
          bubbles: true,
          composed: true,
          detail: {value: this.value},
        }),
      );
    }
  }

  private resetForm(): void {
    this.value = this.getAttribute('value') ?? '';
  }

  private restoreFormState(state: string | File | FormData | null): void {
    if (typeof state === 'string') {
      this.value = state;
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-segmented': MndwSegmented;
  }
}
