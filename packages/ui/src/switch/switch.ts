import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import {FormAssociatedController} from '../forms/form-associated.js';
import {focusRing, hostTypography} from '../styles/base.js';

export const MNDW_SWITCH_TAG = 'mndw-switch';

export interface MndwSwitchChangeDetail {
  checked: boolean;
}

/**
 * Immediate-effect toggle, as distinct from `<mndw-checkbox>` by semantics rather than styling: a
 * switch applies its change at once, a checkbox is submitted with a form.
 */
export class MndwSwitch extends LitElement {
  public static readonly formAssociated = true;

  public static readonly properties: PropertyDeclarations = {
    checked: {type: Boolean, reflect: true},
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
      gap: var(--mndw-space-2);
      align-items: center;
      color: var(--mndw-text);
      cursor: pointer;
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
      display: inline-flex;
      width: var(--mndw-switch-w);
      height: var(--mndw-switch-h);
      flex: 0 0 auto;
      align-items: center;
      padding: 2px;
      border: var(--mndw-border-w) solid var(--mndw-border);
      border-radius: var(--mndw-switch-h);
      background: var(--mndw-surface);
      box-sizing: border-box;
      transition: background var(--mndw-duration-fast) var(--mndw-easing);
    }

    :host(:focus-visible) [part='track'] {
      ${focusRing}
    }

    :host([checked]) [part='track'] {
      border-color: var(--mndw-accent);
      background: var(--mndw-accent);
    }

    [part='thumb'] {
      width: calc(var(--mndw-switch-h) - 8px);
      height: calc(var(--mndw-switch-h) - 8px);
      border-radius: 50%;
      background: var(--mndw-text-subtle);
      transition: transform var(--mndw-duration-fast) var(--mndw-easing);
    }

    :host([checked]) [part='thumb'] {
      background: var(--mndw-accent-contrast);
      transform: translateX(calc(var(--mndw-switch-w) - var(--mndw-switch-h)));
    }
  `;

  declare public checked: boolean;
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

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
    this.required = false;
    this.invalid = false;
    this.value = 'on';
    this.name = '';
    this.addEventListener('click', this.onClick);
    this.addEventListener('keydown', this.onKeyDown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.formState.captureInitialAttributes(['checked']);
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

  protected override render(): TemplateResult {
    return html`
      <span part="track" aria-hidden="true">
        <span part="thumb"></span>
      </span>
      <slot part="label"></slot>
    `;
  }

  protected override updated(): void {
    const effectiveDisabled = this.formState.effectiveDisabled;
    const checked = String(this.checked);

    this.setAttribute('role', 'switch');
    this.setAttribute('aria-checked', checked);
    this.setAttribute('aria-disabled', String(effectiveDisabled));
    this.tabIndex = effectiveDisabled ? -1 : 0;

    // A switch always holds a value, so `required` can never be missing: it is accepted and inert,
    // which means no `aria-required` and no validity flag — see the form-association contract.
    this.formState.setFormValue(this.checked ? this.value : null, this.checked ? 'checked' : 'unchecked');

    const labels = this.formState.labels;
    const labelIds = labels.map((label) => label.id).filter((id) => id !== '');

    if (labelIds.length > 0) {
      this.setAttribute('aria-labelledby', labelIds.join(' '));
    } else {
      this.removeAttribute('aria-labelledby');
    }

    const internals = this.formState.internals;

    if (!internals) {
      return;
    }

    internals.role = 'switch';
    internals.ariaChecked = checked;
    internals.ariaDisabled = String(effectiveDisabled);
    // Element references cross tree boundaries. The reflected IDs above cover engines that do not
    // expose ElementInternals naming relationships to their accessibility tree.
    internals.ariaLabelledByElements = labels;

    if (this.checked) {
      internals.states.add('checked');
    } else {
      internals.states.delete('checked');
    }
  }

  private readonly onClick = (event: Event): void => {
    if (this.formState.effectiveDisabled) {
      event.preventDefault();

      return;
    }

    this.toggle();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.formState.effectiveDisabled || (event.key !== ' ' && event.key !== 'Enter')) {
      return;
    }

    event.preventDefault();
    this.toggle();
  };

  private toggle(): void {
    this.checked = !this.checked;
    this.dispatchEvent(
      new CustomEvent<MndwSwitchChangeDetail>('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: this.checked},
      }),
    );
  }

  private resetForm(): void {
    this.checked = this.hasAttribute('checked');
  }

  private restoreFormState(state: string | File | FormData | null): void {
    if (state === 'checked') {
      this.checked = true;
    } else if (state === 'unchecked') {
      this.checked = false;
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-switch': MndwSwitch;
  }
}
