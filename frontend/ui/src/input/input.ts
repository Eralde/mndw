import {LitElement, type PropertyDeclarations, type PropertyValues, type TemplateResult, css, html, nothing} from 'lit';
import {FormAssociatedController} from '../forms/form-associated.js';
import {CommitTracker, TextAnnouncementController, setOrRemove, validityFlagsFrom} from '../forms/text-control.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';
import {controlBase, focusRing, hostTypography} from '../styles/base.js';

export const MNDW_INPUT_TAG = 'mndw-input';

export const MNDW_INPUT_TYPES = ['text', 'password', 'search', 'number', 'url'] as const;

export type MndwInputType = (typeof MNDW_INPUT_TYPES)[number];

export interface MndwInputChangeDetail {
  value: string;
}

export class MndwInput extends LitElement {
  public static readonly formAssociated = true;

  /** Text controls delegate focus so `<label for>` clicks and `.focus()` reach the native element. */
  public static override readonly shadowRootOptions: ShadowRootInit = {mode: 'open', delegatesFocus: true};

  public static readonly properties: PropertyDeclarations = {
    value: {type: String},
    type: {type: String, reflect: true},
    placeholder: {type: String, reflect: true},
    autocomplete: {type: String, reflect: true},
    readonly: {type: Boolean, reflect: true},
    disabled: {type: Boolean, reflect: true},
    required: {type: Boolean, reflect: true},
    invalid: {type: Boolean, reflect: true},
    name: {type: String, reflect: true},
    min: {type: Number, reflect: true},
    max: {type: Number, reflect: true},
    step: {type: Number, reflect: true},
    maxlength: {type: Number, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-block;
      width: 100%;
    }

    :host([disabled]) {
      opacity: 0.5;
    }

    [part='field'] {
      ${controlBase}

      display: flex;
      gap: var(--mndw-space-2);
      align-items: center;
      width: 100%;
      border: var(--mndw-border-w) solid var(--mndw-border);
      background: var(--mndw-surface-raised);
      color: var(--mndw-text);
    }

    :host(:focus-within) [part='field'] {
      ${focusRing}
    }

    input {
      width: 100%;
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      line-height: var(--mndw-leading);
    }

    input:focus {
      outline: none;
    }

    input::placeholder {
      color: var(--mndw-text-subtle);
    }

    [part='prefix'],
    [part='suffix'] {
      display: inline-flex;
      align-items: center;
      color: var(--mndw-text-subtle);
    }

    [part='prefix'][hidden],
    [part='suffix'][hidden] {
      display: none;
    }

    [part='password-toggle'] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      padding: var(--mndw-space-1);
      border: 0;
      border-radius: var(--mndw-radius-sm);
      background: none;
      color: var(--mndw-text-subtle);
      cursor: pointer;
      font: inherit;
    }

    [part='password-toggle']:hover {
      color: var(--mndw-text);
    }

    :host([disabled]) [part='password-toggle'] {
      pointer-events: none;
    }
  `;

  declare public value: string;
  declare public type: MndwInputType;
  declare public placeholder: string;
  declare public autocomplete: string;
  declare public readonly: boolean;
  declare public disabled: boolean;
  declare public required: boolean;
  declare public invalid: boolean;
  declare public name: string;
  declare public min: number | null;
  declare public max: number | null;
  declare public step: number | null;
  declare public maxlength: number | null;

  private readonly formState = new FormAssociatedController(this, {
    isExplicitlyDisabled: () => this.disabled,
    onReset: () => this.resetForm(),
    onStateRestore: (state) => this.restoreFormState(state),
    onDisabledChange: () => {
      this.requestUpdate();
    },
  });
  private readonly announcement = new TextAnnouncementController(this, {
    formState: this.formState,
    isInvalid: () => this.invalid,
  });
  private readonly commits = new CommitTracker((value) => this.emitChange(value));
  private readonly localeController = new LocaleController(this);
  private _showPassword = false;

  constructor() {
    super();
    this.value = '';
    this.type = 'text';
    this.placeholder = '';
    this.autocomplete = '';
    this.readonly = false;
    this.disabled = false;
    this.required = false;
    this.invalid = false;
    this.name = '';
    this.min = null;
    this.max = null;
    this.step = null;
    this.maxlength = null;
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.formState.captureInitialAttributes(['value']);
    this.announcement.connect();
    this.requestUpdate();
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.announcement.disconnect();
  }

  /**
   * Supported invalidation for the one naming change nothing else catches: a `<label for>` inserted,
   * removed, or re-pointed elsewhere in the tree. `<mndw-field>` calls it after every wiring pass.
   */
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

  public override focus(options?: FocusOptions): void {
    this.innerInput?.focus(options);
  }

  protected override render(): TemplateResult {
    return html`
      <div part="field">
        <slot name="prefix" part="prefix" @slotchange=${this.onAdornmentSlotChange}></slot>
        <input
          part="input"
          type=${this._effectiveType}
          @input=${this.onInnerInput}
          @focus=${this.onInnerFocus}
          @blur=${this.onInnerBlur}
          @keydown=${this.onInnerKeyDown}
        />
        ${this.type === 'password' ? this._renderPasswordToggle() : nothing}
        <slot name="suffix" part="suffix" @slotchange=${this.onAdornmentSlotChange}></slot>
      </div>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    this.syncAdornmentSlots();

    const inner = this.innerInput;

    if (!inner) {
      return;
    }

    this.syncInner(inner);

    if (changed.has('value')) {
      this.commits.syncValue(this.value);
    }

    this.syncFormState(inner);
    this.announcement.sync(inner);
  }

  private syncAdornmentSlots(): void {
    const slots = this.renderRoot.querySelectorAll<HTMLSlotElement>('slot[name="prefix"], slot[name="suffix"]');

    for (const slot of slots) {
      this.syncAdornmentSlot(slot);
    }
  }

  private syncAdornmentSlot(slot: HTMLSlotElement): void {
    slot.hidden = slot.assignedNodes().length === 0;
  }

  private readonly onAdornmentSlotChange = (event: Event): void => {
    const slot = event.currentTarget as HTMLSlotElement | null;

    if (slot) {
      this.syncAdornmentSlot(slot);
    }
  };

  private get innerInput(): HTMLInputElement | null {
    return this.renderRoot.querySelector('input');
  }

  /** The property type union is the contract; anything else degrades to `text` rather than breaking. */
  private get resolvedType(): MndwInputType {
    return MNDW_INPUT_TYPES.includes(this.type) ? this.type : 'text';
  }

  private get _effectiveType(): string {
    return this.type === 'password' && this._showPassword ? 'text' : this.resolvedType;
  }

  private syncInner(inner: HTMLInputElement): void {
    setOrRemove(inner, 'placeholder', this.placeholder);
    setOrRemove(inner, 'autocomplete', this.autocomplete);
    setOrRemove(inner, 'min', this.min === null ? '' : String(this.min));
    setOrRemove(inner, 'max', this.max === null ? '' : String(this.max));
    setOrRemove(inner, 'step', this.step === null ? '' : String(this.step));
    setOrRemove(inner, 'maxlength', this.maxlength === null ? '' : String(this.maxlength));
    inner.toggleAttribute('readonly', this.readonly);
    inner.toggleAttribute('disabled', this.formState.effectiveDisabled);
    inner.toggleAttribute('required', this.required || this.announcement.hasAriaRequired);

    if (inner.value !== this.value) {
      inner.value = this.value;
    }
  }

  private syncFormState(inner: HTMLInputElement): void {
    this.formState.setFormValue(this.value);
    this.formState.setValidity(validityFlagsFrom(inner.validity), inner.validationMessage);
  }

  private readonly onInnerInput = (event: Event): void => {
    this.commits.markUserInput();
    this.value = (event.target as HTMLInputElement).value;
    this.dispatchEvent(
      new CustomEvent<MndwInputChangeDetail>('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: this.value},
      }),
    );
  };

  private readonly onInnerFocus = (): void => {
    this.commits.captureBaseline(this.value);
  };

  private readonly onInnerBlur = (): void => {
    this.commits.commit(this.value);
    this.commits.releaseBaseline();
  };

  /** Enter commits here and does not in `<mndw-textarea>`, where it inserts a newline. */
  private readonly onInnerKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      this.commits.commit(this.value);
    }
  };

  private emitChange(value: string): void {
    this.dispatchEvent(
      new CustomEvent<MndwInputChangeDetail>('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value},
      }),
    );
  }

  private readonly _onTogglePassword = (): void => {
    this._showPassword = !this._showPassword;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      this.innerInput?.focus();
    });
  };

  private _renderPasswordToggle(): TemplateResult {
    return html`
      <button
        part="password-toggle"
        type="button"
        aria-label=${getMndwUiText(this._showPassword ? 'input.password.hide' : 'input.password.show')}
        ?disabled=${this.formState.effectiveDisabled}
        @click=${this._onTogglePassword}
      >
        ${this._showPassword ? MndwInput._eyeOffIcon : MndwInput._eyeIcon}
      </button>
    `;
  }

  private static readonly _eyeIcon: TemplateResult = html`
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  `;

  private static readonly _eyeOffIcon: TemplateResult = html`
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <path d="m6.72 13.93a3 3 0 1 0 4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  `;

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
    'mndw-input': MndwInput;
  }
}
