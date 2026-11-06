import {LitElement, type PropertyDeclarations, css, html} from 'lit';
import {type MndwLabelSource, dispatchLabelChange} from '../field/field.js';
import {FormAssociatedController, FormLabelController} from '../forms/form-associated.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';
import {accentHover, focusRing, hostTypography, surfaceHover} from '../styles/base.js';

export const MNDW_CHECKBOX_TAG = 'mndw-checkbox';

export interface MndwCheckboxChangeDetail {
  checked: boolean;
  indeterminate: boolean;
}

export class MndwCheckbox extends LitElement {
  public static readonly formAssociated = true;

  /** Slotted content is the accessible name, so `<mndw-field>` renders no label of its own. */
  public static readonly mndwLabelSource: MndwLabelSource = 'slot';

  public static readonly properties: PropertyDeclarations = {
    checked: {type: Boolean, reflect: true},
    indeterminate: {type: Boolean, reflect: true},
    disabled: {type: Boolean, reflect: true},
    required: {type: Boolean, reflect: true},
    invalid: {type: Boolean, reflect: true},
    value: {type: String, reflect: true},
    name: {type: String, reflect: true},
  };

  public static override readonly styles = css`
      :host {
        ${hostTypography}

        display: inline-flex;
        align-items: center;
        gap: var(--mndw-space-2);
        color: var(--mndw-text);
        cursor: pointer;
        user-select: none;
      }

      :host([disabled]) {
        color: var(--mndw-text-muted);
        cursor: not-allowed;
        opacity: 0.65;
      }

      [part='label'] {
        cursor: pointer;
      }

      :host([disabled]) [part='label'] {
        cursor: not-allowed;
      }

      [part='box'] {
        position: relative;
        display: inline-grid;
        width: 1.125rem;
        height: 1.125rem;
        place-items: center;
        border: 1px solid var(--mndw-border);
        border-radius: var(--mndw-radius-sm);
        background: var(--mndw-surface);
        color: var(--mndw-accent-contrast);
        flex: 0 0 auto;
      }

      :host([checked]) [part='box'],
      :host([indeterminate]) [part='box'] {
        border-color: var(--mndw-accent);
        background: var(--mndw-accent);
      }

      :host(:not([disabled]):not([aria-disabled='true']):not([invalid]):not([aria-invalid='true']):hover) [part='box'] {
        ${surfaceHover}
      }

      :host([checked]:not([disabled]):not([aria-disabled='true']):not([invalid]):not([aria-invalid='true']):hover) [part='box'],
      :host([indeterminate]:not([disabled]):not([aria-disabled='true']):not([invalid]):not([aria-invalid='true']):hover) [part='box'] {
        ${accentHover}
      }

      [part='mark'] {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: block;
        visibility: hidden;
        font-size: var(--mndw-text-md);
        font-weight: var(--mndw-weight-semibold);
        line-height: 1;
      }

      :host([checked]:not([indeterminate])) [part='mark'] {
        visibility: visible;
      }

      :host([indeterminate]) [part='mark'] {
        visibility: visible;
        width: 0.5625rem;
        height: 0.125rem;
        background: currentColor;
        font-size: 0;
      }

      :host(:focus-visible) {
        outline: none;
      }

      :host(:focus-visible) [part='box'] {
        ${focusRing}
      }
    `;

  declare public checked: boolean;
  declare public indeterminate: boolean;
  declare public disabled: boolean;
  declare public required: boolean;
  declare public invalid: boolean;
  declare public value: string;
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
  private readonly labelObserver: MutationObserver;
  private labelSlot: HTMLSlotElement | null = null;
  private readonly localeController = new LocaleController(this);

  constructor() {
    super();
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.required = false;
    this.invalid = false;
    this.value = 'on';
    this.name = '';
    this.labelObserver = new MutationObserver(() => {
      dispatchLabelChange(this);
    });
    this.addEventListener('click', this.handleClick);
    this.addEventListener('keydown', this.handleKeyDown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.formState.captureInitialAttributes(['checked']);
    this.labelObserver.observe(this, {childList: true, subtree: true, characterData: true});
  }

  public override disconnectedCallback(): void {
    this.labelObserver.disconnect();
    this.labelSlot?.removeEventListener('slotchange', this.onLabelSlotChange);
    this.labelSlot = null;
    super.disconnectedCallback();
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

  protected override render(): unknown {
    return html`
      <div
        part="box"
        aria-hidden="true"
      >
        <span part="mark"><mndw-icon name="check"></mndw-icon></span>
      </div>
      <slot part="label"></slot>
    `;
  }

  protected override updated(): void {
    const labelSlot = this.shadowRoot?.querySelector<HTMLSlotElement>('slot[part="label"]') ?? null;

    if (labelSlot !== this.labelSlot) {
      this.labelSlot?.removeEventListener('slotchange', this.onLabelSlotChange);
      labelSlot?.addEventListener('slotchange', this.onLabelSlotChange);
      this.labelSlot = labelSlot;
    }

    const ariaChecked = this.indeterminate ? 'mixed' : String(this.checked);
    const effectiveDisabled = this.formState.effectiveDisabled;

    this.setAttribute('role', 'checkbox');
    this.setAttribute('aria-checked', ariaChecked);
    this.setAttribute('aria-disabled', String(effectiveDisabled));
    this.setAttribute('aria-required', String(this.required));
    this.tabIndex = effectiveDisabled ? -1 : 0;

    const labels = this.formState.labels;

    this.labelController.sync(labels, this.formState.internals);

    this.formState.internals?.setFormValue(
      this.checked ? this.value : null,
      this.indeterminate ? 'indeterminate' : this.checked ? 'checked' : 'unchecked',
    );

    if (this.formState.internals) {
      this.formState.internals.role = 'checkbox';
      this.formState.internals.ariaChecked = ariaChecked;
      this.formState.internals.ariaDisabled = String(effectiveDisabled);
      this.formState.internals.ariaRequired = String(this.required);

      if (this.checked) {
        this.formState.internals.states.add('checked');
      } else {
        this.formState.internals.states.delete('checked');
      }
    }

    if (this.required && !this.checked) {
      this.formState.setValidity({valueMissing: true}, getMndwUiText('checkbox.validation.required'));
    } else {
      this.formState.clearValidity();
    }

    const invalid = this.invalid
      || (this.required && !this.checked)
      || (this.formState.internals?.validity?.valid === false);

    this.setAttribute('aria-invalid', String(invalid));

    if (this.formState.internals) {
      this.formState.internals.ariaInvalid = String(invalid);
    }
  }

  private readonly onLabelSlotChange = (): void => {
    dispatchLabelChange(this);
  };

  private readonly handleClick = (event: Event): void => {
    if (this.formState.effectiveDisabled) {
      event.preventDefault();

      return;
    }

    this.toggle();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.formState.effectiveDisabled || (event.key !== ' ' && event.key !== 'Enter')) {
      return;
    }

    event.preventDefault();
    this.toggle();
  };

  private toggle(): void {
    this.indeterminate = false;
    this.checked = !this.checked;
    this.dispatchEvent(
      new CustomEvent<MndwCheckboxChangeDetail>('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: this.checked, indeterminate: this.indeterminate},
      }),
    );
  }

  private readonly resetForm = (): void => {
    this.checked = this.hasAttribute('checked');
    this.indeterminate = false;
  };

  private readonly restoreFormState = (state: string | File | FormData | null): void => {
    if (typeof state !== 'string') {
      return;
    }

    if (state === 'checked') {
      this.checked = true;
      this.indeterminate = false;
    } else if (state === 'unchecked') {
      this.checked = false;
      this.indeterminate = false;
    } else if (state === 'indeterminate') {
      this.checked = false;
      this.indeterminate = true;
    }
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-checkbox': MndwCheckbox;
  }
}
