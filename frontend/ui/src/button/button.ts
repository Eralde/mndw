import {LitElement, type PropertyDeclarations, type TemplateResult, css, html, nothing} from 'lit';
import {FormAssociatedController} from '../forms/form-associated.js';
import {controlBase, focusRing, hostTypography} from '../styles/base.js';

export const MNDW_BUTTON_TAG = 'mndw-button';

export type MndwButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export class MndwButton extends LitElement {
  public static readonly formAssociated = true;

  public static override readonly shadowRootOptions: ShadowRootInit = {
    mode: 'open',
    delegatesFocus: true,
  };

  public static properties: PropertyDeclarations = {
    variant: {type: String, reflect: true},
    disabled: {type: Boolean, reflect: true},
    type: {type: String},
    ariaLabel: {type: String, attribute: 'aria-label'},
  };

  public static styles = css`
    :host {
      ${hostTypography}

      display: inline-block;
    }

    :host([disabled]) {
      pointer-events: none;
      opacity: 0.5;
    }

    button {
      ${controlBase}

      display: inline-flex;
      gap: var(--mndw-space-2);
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      font-weight: var(--mndw-weight-semibold);
      cursor: pointer;
    }

    button:focus-visible {
      ${focusRing}
    }

    :host([variant='primary']) button {
      border-color: var(--mndw-accent);
      background: var(--mndw-accent);
      color: var(--mndw-accent-contrast);
    }

    :host([variant='primary']) button:hover {
      border-color: var(--mndw-accent-hover);
      background: var(--mndw-accent-hover);
    }

    :host([variant='secondary']) button {
      border-color: var(--mndw-border);
      background: var(--mndw-surface-raised);
      color: var(--mndw-text);
    }

    :host([variant='ghost']) button {
      background: transparent;
      color: var(--mndw-text-subtle);
    }

    :host([variant='ghost']) button:hover {
      background: color-mix(in srgb, var(--mndw-text) 8%, transparent);
      color: var(--mndw-text);
    }

    /*
     * A tint, not a solid fill: the palette models danger as a foreground and emits no
     * dangerContrast pair, so filling the button with it would be an unvalidated combination.
     */
    :host([variant='danger']) button {
      border-color: var(--mndw-danger);
      background: var(--mndw-danger-bg);
      color: var(--mndw-danger);
    }

    :host([variant='danger']) button:hover {
      background: color-mix(in srgb, var(--mndw-danger) 12%, var(--mndw-danger-bg));
    }
  `;

  declare public variant: MndwButtonVariant;
  declare public disabled: boolean;
  declare public type: 'button' | 'submit' | 'reset';
  declare public ariaLabel: string;

  private readonly formState = new FormAssociatedController(this, {
    isExplicitlyDisabled: () => this.disabled,
    onReset: () => {},
    onStateRestore: () => {},
    onDisabledChange: () => {
      this.requestUpdate();
    },
  });

  constructor() {
    super();

    this.variant = 'secondary';
    this.disabled = false;
    this.type = 'button';
    this.ariaLabel = '';
    this.addEventListener('click', this.onClick);
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

  protected render(): TemplateResult {
    return html`
      <button
        part="button"
        type="button"
        aria-label=${this.ariaLabel || nothing}
        ?disabled=${this.formState.effectiveDisabled}
      >
        <slot></slot>
      </button>
    `;
  }

  protected override updated(): void {
    const inner = this.renderRoot.querySelector<HTMLButtonElement>('button');

    if (!inner) {
      return;
    }

    inner.disabled = this.formState.effectiveDisabled;
  }

  private readonly onClick = (event: Event): void => {
    if (this.formState.effectiveDisabled) {
      event.preventDefault();

      return;
    }

    const form = this.formState.form;

    if (!form) {
      return;
    }

    if (this.type === 'submit') {
      form.requestSubmit();
    } else if (this.type === 'reset') {
      form.reset();
    }
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-button': MndwButton;
  }
}
