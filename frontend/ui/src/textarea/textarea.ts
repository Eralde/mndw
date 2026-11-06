import {LitElement, type PropertyDeclarations, type PropertyValues, type TemplateResult, css, html} from 'lit';
import {FormAssociatedController} from '../forms/form-associated.js';
import {CommitTracker, TextAnnouncementController, setOrRemove, validityFlagsFrom} from '../forms/text-control.js';
import {fieldHover, focusRing, hostTypography} from '../styles/base.js';

export const MNDW_TEXTAREA_TAG = 'mndw-textarea';

export interface MndwTextareaChangeDetail {
  value: string;
}

export class MndwTextarea extends LitElement {
  public static readonly formAssociated = true;

  /** Text controls delegate focus so `<label for>` clicks and `.focus()` reach the native element. */
  public static override readonly shadowRootOptions: ShadowRootInit = {mode: 'open', delegatesFocus: true};

  public static readonly properties: PropertyDeclarations = {
    value: {type: String},
    rows: {type: Number, reflect: true},
    autosize: {type: Boolean, reflect: true},
    readonly: {type: Boolean, reflect: true},
    disabled: {type: Boolean, reflect: true},
    required: {type: Boolean, reflect: true},
    invalid: {type: Boolean, reflect: true},
    name: {type: String, reflect: true},
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
      box-sizing: border-box;
      display: flex;
      width: 100%;
      padding: var(--mndw-space-2) var(--mndw-space-3);
      border: var(--mndw-border-w) solid var(--mndw-border);
      border-radius: var(--mndw-radius-md);
      background: var(--mndw-surface-raised);
      color: var(--mndw-text);
    }

    :host(:not([disabled]):not([readonly]):not([invalid]):not([aria-invalid='true'])) [part='field']:hover {
      ${fieldHover}
    }

    :host(:focus-within) [part='field'] {
      ${focusRing}
    }

    textarea {
      width: 100%;
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      line-height: var(--mndw-leading);
      resize: vertical;
    }

    :host([autosize]) textarea {
      overflow: hidden;
      resize: none;
    }

    textarea:focus {
      outline: none;
    }

    textarea::placeholder {
      color: var(--mndw-text-subtle);
    }
  `;

  declare public value: string;
  declare public rows: number;
  declare public autosize: boolean;
  declare public readonly: boolean;
  declare public disabled: boolean;
  declare public required: boolean;
  declare public invalid: boolean;
  declare public name: string;
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
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    super();
    this.value = '';
    this.rows = 3;
    this.autosize = false;
    this.readonly = false;
    this.disabled = false;
    this.required = false;
    this.invalid = false;
    this.name = '';
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
    this.stopAutosize();
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
    this.innerTextarea?.focus(options);
  }

  protected override render(): TemplateResult {
    return html`
      <div part="field">
        <textarea
          part="textarea"
          @input=${this.onInnerInput}
          @focus=${this.onInnerFocus}
          @blur=${this.onInnerBlur}
        ></textarea>
      </div>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    const inner = this.innerTextarea;

    if (!inner) {
      return;
    }

    this.syncInner(inner);

    if (changed.has('value')) {
      this.commits.syncValue(this.value);
    }

    this.syncFormState(inner);
    this.announcement.sync(inner);
    this.syncAutosize(inner);
  }

  private get innerTextarea(): HTMLTextAreaElement | null {
    return this.renderRoot.querySelector('textarea');
  }

  private syncInner(inner: HTMLTextAreaElement): void {
    setOrRemove(inner, 'maxlength', this.maxlength === null ? '' : String(this.maxlength));
    // Autosize drives the height from content, so a `rows` floor would fight it.
    setOrRemove(inner, 'rows', this.autosize ? '' : String(this.rows));
    inner.toggleAttribute('readonly', this.readonly);
    inner.toggleAttribute('disabled', this.formState.effectiveDisabled);
    inner.toggleAttribute('required', this.required || this.announcement.hasAriaRequired);

    if (inner.value !== this.value) {
      inner.value = this.value;
    }
  }

  private syncFormState(inner: HTMLTextAreaElement): void {
    this.formState.setFormValue(this.value);
    this.formState.setValidity(validityFlagsFrom(inner.validity), inner.validationMessage);
  }

  /** Opt-in, because it costs an observer: width changes reflow the text and change its height. */
  private syncAutosize(inner: HTMLTextAreaElement): void {
    if (!this.autosize) {
      this.stopAutosize();
      inner.style.removeProperty('height');

      return;
    }

    if (!this.resizeObserver && typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeToContent(inner);
      });
      this.resizeObserver.observe(inner);
    }

    this.resizeToContent(inner);
  }

  private resizeToContent(inner: HTMLTextAreaElement): void {
    inner.style.height = 'auto';
    inner.style.height = `${inner.scrollHeight}px`;
  }

  private stopAutosize(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private readonly onInnerInput = (event: Event): void => {
    this.commits.markUserInput();
    this.value = (event.target as HTMLTextAreaElement).value;
    this.dispatchEvent(
      new CustomEvent<MndwTextareaChangeDetail>('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: this.value},
      }),
    );
  };

  private readonly onInnerFocus = (): void => {
    this.commits.captureBaseline(this.value);
  };

  /** Blur is the only commit gesture: Enter inserts a newline, matching a native `<textarea>`. */
  private readonly onInnerBlur = (): void => {
    this.commits.commit(this.value);
    this.commits.releaseBaseline();
  };

  private emitChange(value: string): void {
    this.dispatchEvent(
      new CustomEvent<MndwTextareaChangeDetail>('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value},
      }),
    );
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
    'mndw-textarea': MndwTextarea;
  }
}
