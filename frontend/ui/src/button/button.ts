import {LitElement, type PropertyDeclarations, type TemplateResult, css, html, nothing} from 'lit';
import {FormAssociatedController} from '../forms/form-associated.js';
import {
  accentHover,
  controlBase,
  controlHover,
  focusRing,
  hostTypography,
  surfaceHover,
  textHover,
} from '../styles/base.js';

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
    ariaExpanded: {type: String, attribute: 'aria-expanded'},
    ariaPressed: {type: String, attribute: 'aria-pressed'},
    ariaHaspopup: {type: String, attribute: 'aria-haspopup'},
    ariaControls: {type: String, attribute: 'aria-controls'},
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

    :host([variant='primary']) button:not(:disabled):hover {
      ${accentHover}
    }

    :host([variant='secondary']) button {
      border-color: var(--mndw-border);
      background: var(--mndw-surface-raised);
      color: var(--mndw-text);
    }

    :host([variant='secondary']) button:not(:disabled):hover {
      ${surfaceHover}
      border-color: var(--mndw-text-subtle);
    }

    :host([variant='ghost']) button {
      background: transparent;
      color: var(--mndw-text-subtle);
    }

    :host([variant='ghost']) button:not(:disabled):hover {
      ${controlHover}
      ${textHover}
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

    :host([variant='danger']) button:not(:disabled):hover {
      background: color-mix(in srgb, var(--mndw-danger) 12%, var(--mndw-danger-bg));
    }
  `;

  declare public variant: MndwButtonVariant;
  declare public disabled: boolean;
  declare public type: 'button' | 'submit' | 'reset';
  declare public ariaLabel: string;
  declare public ariaExpanded: string;
  declare public ariaPressed: string;
  declare public ariaHaspopup: string;
  declare public ariaControls: string;

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
    this.ariaExpanded = '';
    this.ariaPressed = '';
    this.ariaHaspopup = '';
    this.ariaControls = '';
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
        aria-expanded=${this.ariaExpanded || nothing}
        aria-pressed=${this.ariaPressed || nothing}
        aria-haspopup=${this.ariaHaspopup || nothing}
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
    this.syncAriaControls(inner);
  }

  /**
   * `aria-controls` is an IDREF list, so it cannot cross the shadow boundary as a plain
   * attribute: the inner button lives in the shadow root while the controlled element is in
   * the light DOM. Where the platform supports `ariaControlsElements` the references are
   * resolved in the document and exposed on the inner button directly. Browsers without it
   * get the string attribute copied over; it may not reach assistive technology there.
   */
  private syncAriaControls(inner: HTMLButtonElement): void {
    const ids = this.ariaControls
      ?.trim()
      .split(/\s+/)
      .filter((id) => id !== '')
      ?? [];

    // The cast is only for feature detection: with the property present in the DOM lib typings,
    // a plain `in` check would narrow the else branch to `never`.
    const supportsAriaControlsElements = 'ariaControlsElements' in (inner as unknown as object);

    if (supportsAriaControlsElements) {
      const elements = ids
        .map((id) => this.ownerDocument.getElementById(id))
        .filter((element): element is HTMLElement => element !== null);

      // The setter manages the content attribute itself: per the HTML spec, any change or
      // removal of the attribute afterwards would null the explicitly set elements, so the
      // attribute must not be touched here. Clearing the relation means assigning null.
      inner.ariaControlsElements = elements.length > 0 ? elements : null;
    } else {
      const value = ids.join(' ');

      if (value === '') {
        inner.removeAttribute('aria-controls');
      } else {
        inner.setAttribute('aria-controls', value);
      }
    }
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
