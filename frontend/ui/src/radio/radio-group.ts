import {LitElement, type PropertyDeclarations, type PropertyValues, type TemplateResult, css, html} from 'lit';
import {type MndwLabelSource, dispatchLabelChange} from '../field/field.js';
import {FormAssociatedController} from '../forms/form-associated.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';
import {type MndwControlSize, hostTypography} from '../styles/base.js';
import {MNDW_RADIO_CHANGE_EVENT, MNDW_RADIO_TAG, type MndwRadio} from './radio.js';

export const MNDW_RADIO_GROUP_TAG = 'mndw-radio-group';

export interface MndwRadioGroupChangeDetail {
  value: string;
}

/** Attributes the group writes onto its radios, and therefore the only ones it may remove. */
const OWNED_RADIO_ATTRIBUTES = ['role', 'aria-checked', 'aria-disabled', 'tabindex'];

const FORWARD_KEYS = ['ArrowRight', 'ArrowDown'];
const BACKWARD_KEYS = ['ArrowLeft', 'ArrowUp'];

export class MndwRadioGroup extends LitElement {
  public static readonly formAssociated = true;

  /** A non-empty `label` is the accessible name; its children are radios, never labels. */
  public static readonly mndwLabelSource: MndwLabelSource = 'label-property';

  public static readonly properties: PropertyDeclarations = {
    value: {type: String},
    size: {type: String, reflect: true},
    orientation: {type: String, reflect: true},
    label: {type: String},
    disabled: {type: Boolean, reflect: true},
    required: {type: Boolean, reflect: true},
    name: {type: String, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-flex;
      --_mndw-radio-indicator-size: 1.125rem;
      --_mndw-radio-label-gap: var(--mndw-space-2);
    }

    :host([size='sm']) {
      --_mndw-radio-indicator-size: 1rem;
      --_mndw-radio-label-gap: var(--mndw-space-1);
    }

    :host([disabled]) {
      pointer-events: none;
      opacity: 0.5;
    }

    [part='group'] {
      display: flex;
      flex-direction: column;
      gap: var(--mndw-space-2);
    }

    :host([orientation='horizontal']) [part='group'] {
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--mndw-space-4);
    }
  `;

  declare public value: string;
  declare public size: MndwControlSize;
  declare public orientation: 'vertical' | 'horizontal';
  declare public label: string;
  declare public disabled: boolean;
  declare public required: boolean;
  declare public name: string;

  private readonly formState = new FormAssociatedController(this, {
    isExplicitlyDisabled: () => this.disabled,
    onReset: () => this.resetForm(),
    onStateRestore: (state) => this.restoreFormState(state),
    onDisabledChange: () => {
      this.requestUpdate();
    },
  });
  private owned: MndwRadio[] = [];
  private ownsAriaLabel = false;
  private ownedAriaLabel: string | null = null;
  private readonly localeController = new LocaleController(this);

  constructor() {
    super();
    this.value = '';
    this.size = 'md';
    this.orientation = 'vertical';
    this.label = '';
    this.disabled = false;
    this.required = false;
    this.name = '';
    this.addEventListener('click', this.onClick);
    this.addEventListener('keydown', this.onKeyDown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.formState.captureInitialAttributes(['value']);
    this.addEventListener(MNDW_RADIO_CHANGE_EVENT, this.onRadioChange);
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener(MNDW_RADIO_CHANGE_EVENT, this.onRadioChange);
    this.releaseRadios(this.owned);
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
    const selected = this.syncRadios();

    this.syncHost(selected);
    this.syncFormState(selected);

    // A label source that changes after mount would leave a wrapping field's suppression stale.
    if (changed.has('label') && changed.get('label') !== undefined) {
      dispatchLabelChange(this);
    }
  }

  /** A radio with no value is ignored rather than treated as an error. */
  private radios(): MndwRadio[] {
    return [...this.children].filter((child): child is MndwRadio =>
      child.localName === MNDW_RADIO_TAG && (child as MndwRadio).value !== ''
    );
  }

  private isRadioDisabled(radio: MndwRadio): boolean {
    return radio.disabled || this.formState.effectiveDisabled;
  }

  private syncRadios(): MndwRadio | null {
    const radios = this.radios();
    const selected = radios.find((radio) => radio.value === this.value) ?? null;
    const tabStop = selected && !this.isRadioDisabled(selected)
      ? selected
      : radios.find((radio) => !this.isRadioDisabled(radio)) ?? null;

    this.releaseRadios(this.owned.filter((radio) => !radios.includes(radio)));

    for (const radio of radios) {
      radio.setAttribute('role', 'radio');
      radio.setAttribute('aria-checked', String(radio === selected));
      radio.setAttribute('aria-disabled', String(this.isRadioDisabled(radio)));
      radio.setAttribute('tabindex', radio === tabStop && !this.formState.effectiveDisabled ? '0' : '-1');
    }

    this.owned = radios;

    return selected;
  }

  private releaseRadios(radios: readonly MndwRadio[]): void {
    for (const radio of radios) {
      for (const attribute of OWNED_RADIO_ATTRIBUTES) {
        radio.removeAttribute(attribute);
      }
    }
  }

  private syncHost(selected: MndwRadio | null): void {
    const effectiveDisabled = this.formState.effectiveDisabled;
    const orientation = this.orientation === 'horizontal' ? 'horizontal' : 'vertical';
    const invalid = this.required && !selected;

    this.setAttribute('role', 'radiogroup');
    this.setAttribute('aria-orientation', orientation);
    this.setAttribute('aria-disabled', String(effectiveDisabled));
    this.setAttribute('aria-required', String(this.required));
    this.setAttribute('aria-invalid', String(invalid));
    this.syncAccessibleLabel();

    const internals = this.formState.internals;

    if (!internals) {
      return;
    }

    internals.role = 'radiogroup';
    internals.ariaOrientation = orientation;
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

  private syncFormState(selected: MndwRadio | null): void {
    this.formState.setFormValue(selected ? selected.value : null, this.value);

    if (this.required && !selected) {
      const anchor = this.radios().find((radio) => !this.isRadioDisabled(radio));

      this.formState.setValidity({valueMissing: true}, getMndwUiText('radio-group.validation.required'), anchor);
    } else {
      this.formState.clearValidity();
    }
  }

  private readonly onSlotChange = (): void => {
    this.requestUpdate();
  };

  private readonly onRadioChange = (): void => {
    this.requestUpdate();
  };

  private readonly onClick = (event: Event): void => {
    const radio = this.radioFrom(event.target);

    if (!radio || this.isRadioDisabled(radio)) {
      return;
    }

    this.activate(radio);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.formState.effectiveDisabled) {
      return;
    }

    const focusable = this.radios().filter((radio) => !this.isRadioDisabled(radio));

    if (focusable.length === 0) {
      return;
    }

    const next = this.nextRadio(event.key, focusable, this.radioFrom(event.target));

    if (!next) {
      return;
    }

    event.preventDefault();
    this.activate(next);
  };

  private nextRadio(key: string, focusable: MndwRadio[], from: MndwRadio | null): MndwRadio | null {
    const current = from ? focusable.indexOf(from) : -1;
    const last = focusable.length - 1;

    if (FORWARD_KEYS.includes(key)) {
      return focusable[current < 0 || current === last ? 0 : current + 1];
    }

    if (BACKWARD_KEYS.includes(key)) {
      return focusable[current <= 0 ? last : current - 1];
    }

    if (key === ' ' && current >= 0) {
      return focusable[current];
    }

    return null;
  }

  private radioFrom(target: EventTarget | null): MndwRadio | null {
    const radio = target instanceof Element ? target.closest<MndwRadio>(MNDW_RADIO_TAG) : null;

    return radio?.parentElement === this ? radio : null;
  }

  private activate(radio: MndwRadio): void {
    const changed = this.value !== radio.value;

    this.value = radio.value;
    radio.focus();

    if (changed) {
      this.dispatchEvent(
        new CustomEvent<MndwRadioGroupChangeDetail>('mndwchange', {
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
    'mndw-radio-group': MndwRadioGroup;
  }
}
