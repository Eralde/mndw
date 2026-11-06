import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import {FormAssociatedController, FormLabelController} from '../forms/form-associated.js';
import {accentHover, focusRing, hostTypography, surfaceHover} from '../styles/base.js';

export const MNDW_SLIDER_TAG = 'mndw-slider';

export interface MndwSliderInputDetail {
  value: number;
}

export interface MndwSliderChangeDetail {
  value: number;
}

const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;
const DEFAULT_STEP = 1;

/** PageUp and PageDown jump a tenth of the range, never less than one step. */
const PAGE_DIVISIONS = 10;

/** Enough digits to keep `0.1 + 0.2` off the value while preserving any step an author can author. */
const STEP_PRECISION = 12;

const INCREMENT_KEYS = ['ArrowRight', 'ArrowUp'];
const DECREMENT_KEYS = ['ArrowLeft', 'ArrowDown'];

/**
 * Range control with the host as the slider: `value` is a `number` end to end, and only the form
 * value is stringified.
 */
export class MndwSlider extends LitElement {
  public static readonly formAssociated = true;

  public static readonly properties: PropertyDeclarations = {
    // State, so it does not reflect: the `value` attribute stays the default that reset restores.
    value: {type: Number},
    min: {type: Number, reflect: true},
    max: {type: Number, reflect: true},
    step: {type: Number, reflect: true},
    // Author-supplied announcement text. It does not reflect, because reflecting the empty default
    // would put a `value-text=""` attribute on every slider that never sets one.
    valueText: {type: String, attribute: 'value-text'},
    disabled: {type: Boolean, reflect: true},
    required: {type: Boolean, reflect: true},
    invalid: {type: Boolean, reflect: true},
    name: {type: String, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-flex;
      width: 100%;
      min-height: var(--mndw-control-h);
      gap: var(--mndw-space-3);
      align-items: center;
      color: var(--mndw-text);
      cursor: pointer;
      touch-action: none;
      user-select: none;
    }

    :host([disabled]) {
      color: var(--mndw-text-muted);
      cursor: not-allowed;
      opacity: 0.65;
    }

    :host(:focus-visible) {
      outline: none;
    }

    [part='track'] {
      position: relative;
      height: var(--mndw-slider-track-h);
      flex: 1 1 auto;
      border-radius: var(--mndw-slider-track-h);
      background: var(--mndw-surface);
    }

    :host(:not([disabled]):not([aria-disabled='true']):not([invalid]):not([aria-invalid='true'])) [part='track']:hover {
      ${surfaceHover}
    }

    [part='fill'] {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      border-radius: inherit;
      background: var(--mndw-accent);
    }

    [part='thumb'] {
      position: absolute;
      top: 50%;
      width: var(--mndw-slider-thumb-size);
      height: var(--mndw-slider-thumb-size);
      border: var(--mndw-border-w) solid var(--mndw-accent-contrast);
      border-radius: 50%;
      background: var(--mndw-accent);
      box-sizing: border-box;
      transform: translate(-50%, -50%);
    }

    :host(:not([disabled]):not([aria-disabled='true']):not([invalid]):not([aria-invalid='true'])) [part='thumb']:hover {
      ${accentHover}
    }

    :host(:focus-visible) [part='thumb'] {
      ${focusRing}
    }

    :host([disabled]) [part='fill'],
    :host([disabled]) [part='thumb'] {
      background: var(--mndw-text-subtle);
    }

    :host([disabled]) [part='thumb'] {
      border-color: var(--mndw-surface);
    }

    [part='output'] {
      flex: 0 0 auto;
      color: var(--mndw-text-muted);
      font-size: var(--mndw-text-xs);
      font-variant-numeric: tabular-nums;
    }
  `;

  declare public value: number;
  declare public min: number;
  declare public max: number;
  declare public step: number;
  declare public valueText: string;
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
  private readonly labelController = new FormLabelController(this);
  private dragPointer: number | null = null;
  private dragBaseline = 0;

  constructor() {
    super();
    this.value = DEFAULT_MIN;
    this.min = DEFAULT_MIN;
    this.max = DEFAULT_MAX;
    this.step = DEFAULT_STEP;
    this.valueText = '';
    this.disabled = false;
    this.required = false;
    this.invalid = false;
    this.name = '';
    this.addEventListener('keydown', this.onKeyDown);
    this.addEventListener('pointerdown', this.onPointerDown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.formState.captureInitialAttributes(['value']);
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.endDrag(false);
  }

  public refreshAccessibleName(): void {
    this.requestUpdate();
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

  protected override willUpdate(): void {
    this.min = Number.isFinite(this.min) ? this.min : DEFAULT_MIN;
    this.max = Number.isFinite(this.max) ? this.max : DEFAULT_MAX;
    this.step = Number.isFinite(this.step) && this.step > 0 ? this.step : DEFAULT_STEP;

    const normalized = this.normalizeValue(this.value);

    if (normalized !== this.value) {
      this.value = normalized;
    }
  }

  protected override render(): TemplateResult {
    const percent = this.percent;

    return html`
      <div part="track">
        <div part="fill" style="width: ${percent}%"></div>
        <div part="thumb" style="left: ${percent}%"></div>
      </div>
      <span part="output" aria-hidden="true">${this.valueText || String(this.value)}</span>
    `;
  }

  protected override updated(): void {
    const effectiveDisabled = this.formState.effectiveDisabled;

    this.setAttribute('role', 'slider');
    this.setAttribute('aria-valuenow', String(this.value));
    this.setAttribute('aria-valuemin', String(this.min));
    this.setAttribute('aria-valuemax', String(this.max));
    this.setAttribute('aria-orientation', 'horizontal');
    this.setAttribute('aria-disabled', String(effectiveDisabled));
    this.tabIndex = effectiveDisabled ? -1 : 0;

    // An empty `valueText` leaves `aria-valuetext` absent so the browser announces `aria-valuenow`;
    // an empty one would be announced as the name of the value by some engines.
    if (this.valueText) {
      this.setAttribute('aria-valuetext', this.valueText);
    } else {
      this.removeAttribute('aria-valuetext');
    }

    // A slider always holds a value, so `required` can never be missing: it is accepted and inert,
    // which means no `aria-required` and no `valueMissing` — see the form-association contract.
    this.formState.setFormValue(String(this.value), String(this.value));
    this.syncValidity();
    this.syncLabels();
  }

  private get percent(): number {
    const range = this.max - this.min;

    if (range <= 0) {
      return 0;
    }

    return Math.min(Math.max(((this.value - this.min) / range) * 100, 0), 100);
  }

  /** Clamps into range and onto the step grid measured from `min`, as a native `range` does. */
  private normalizeValue(value: number): number {
    const raw = Number.isFinite(value) ? value : this.min;
    const clamped = Math.min(Math.max(raw, this.min), this.max);
    const steps = Math.round((clamped - this.min) / this.step);
    const snapped = this.min + steps * this.step;
    // Rounding can overshoot `max`; the last aligned step below it is what a native `range` keeps.
    // `min` is deliberately not a second floor: a `min` above `max` clamps to `max` and is then
    // reported as `rangeUnderflow` rather than silently reordered.
    const bounded = snapped > this.max
      ? this.min + Math.floor((this.max - this.min) / this.step) * this.step
      : snapped;

    return Number.parseFloat(bounded.toPrecision(STEP_PRECISION));
  }

  private syncLabels(): void {
    const labels = this.formState.labels;
    const internals = this.formState.internals;

    this.labelController.sync(labels, internals);

    if (!internals) {
      return;
    }

    internals.role = 'slider';
    internals.ariaValueNow = String(this.value);
    internals.ariaValueMin = String(this.min);
    internals.ariaValueMax = String(this.max);
    internals.ariaValueText = this.valueText || null;
    internals.ariaOrientation = 'horizontal';
    internals.ariaDisabled = String(this.formState.effectiveDisabled);
  }

  /**
   * Normalization keeps the value in range and on the grid, so these flags only fire when the
   * configuration itself contradicts — `min` above `max`, most often from a half-applied binding.
   */
  private syncValidity(): void {
    if (this.value < this.min) {
      this.formState.setValidity({rangeUnderflow: true}, `Value must be ${this.min} or more.`);

      return;
    }

    if (this.value > this.max) {
      this.formState.setValidity({rangeOverflow: true}, `Value must be ${this.max} or less.`);

      return;
    }

    const offset = (this.value - this.min) / this.step;

    if (Math.abs(offset - Math.round(offset)) > Number.EPSILON) {
      this.formState.setValidity({stepMismatch: true}, `Value must be a multiple of ${this.step}.`);

      return;
    }

    this.formState.clearValidity();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.formState.effectiveDisabled) {
      return;
    }

    const target = this.keyValue(event.key);

    if (target === null) {
      return;
    }

    event.preventDefault();

    // Keyboard has no keystroke-end to wait for, so a moved value commits on the same keystroke,
    // exactly as a native `<input type="range">` does.
    if (this.applyUserValue(target)) {
      this.dispatchChange();
    }
  };

  private keyValue(key: string): number | null {
    if (INCREMENT_KEYS.includes(key)) {
      return this.value + this.step;
    }

    if (DECREMENT_KEYS.includes(key)) {
      return this.value - this.step;
    }

    const page = Math.max(this.step, (this.max - this.min) / PAGE_DIVISIONS);

    if (key === 'PageUp') {
      return this.value + page;
    }

    if (key === 'PageDown') {
      return this.value - page;
    }

    if (key === 'Home') {
      return this.min;
    }

    if (key === 'End') {
      return this.max;
    }

    return null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.formState.effectiveDisabled || event.isPrimary === false || this.dragPointer !== null) {
      return;
    }

    event.preventDefault();
    this.dragPointer = event.pointerId;
    this.dragBaseline = this.value;
    this.focus();

    // Capture keeps hover and selection sane while dragging; the window listeners below are what
    // actually deliver the move, so a browser that refuses the capture still drags correctly.
    if (typeof this.setPointerCapture === 'function') {
      this.setPointerCapture(event.pointerId);
    }

    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.applyUserValue(this.valueFromPointer(event));
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.dragPointer !== event.pointerId) {
      return;
    }

    this.applyUserValue(this.valueFromPointer(event));
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.dragPointer !== event.pointerId) {
      return;
    }

    this.endDrag(true);
  };

  private endDrag(commit: boolean): void {
    if (this.dragPointer === null) {
      return;
    }

    const pointerId = this.dragPointer;

    this.dragPointer = null;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);

    if (typeof this.releasePointerCapture === 'function' && this.hasPointerCapture(pointerId)) {
      this.releasePointerCapture(pointerId);
    }

    // A drag that ends where it started is not a change, which is what stops a stray click on the
    // current position from committing.
    if (commit && this.value !== this.dragBaseline) {
      this.dispatchChange();
    }
  }

  private valueFromPointer(event: PointerEvent): number {
    const track = this.renderRoot.querySelector('[part="track"]');
    const rect = track?.getBoundingClientRect();

    if (!rect || rect.width === 0) {
      return this.value;
    }

    return this.min + ((event.clientX - rect.left) / rect.width) * (this.max - this.min);
  }

  /** Writes a user-driven value and reports it. Returns whether the value actually moved. */
  private applyUserValue(raw: number): boolean {
    const next = this.normalizeValue(raw);

    if (next === this.value) {
      return false;
    }

    this.value = next;
    this.dispatchEvent(
      new CustomEvent<MndwSliderInputDetail>('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: next},
      }),
    );

    return true;
  }

  private dispatchChange(): void {
    this.dispatchEvent(
      new CustomEvent<MndwSliderChangeDetail>('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: this.value},
      }),
    );
  }

  private resetForm(): void {
    const authored = this.getAttribute('value');
    const parsed = authored === null ? Number.NaN : Number(authored);

    this.value = Number.isFinite(parsed) ? parsed : this.min;
  }

  private restoreFormState(state: string | File | FormData | null): void {
    if (typeof state !== 'string') {
      return;
    }

    const parsed = Number(state);

    if (Number.isFinite(parsed) && state.trim() !== '') {
      this.value = parsed;
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-slider': MndwSlider;
  }
}
