import {LitElement, type PropertyDeclarations, type PropertyValues, type TemplateResult, css, html} from 'lit';
import {type MndwLabelSource, dispatchLabelChange} from '../field/field.js';
import {deepActiveElement, focusWithinWithRetry} from '../focus.js';
import {FormAssociatedController, FormLabelController} from '../forms/form-associated.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';
import {type LocalizedPropertyState, createLocalizedProperty} from '../localized-property.js';
import {type UiCloseReason, type UiLayer, type UiLayerPresentation, getOverlayProvider} from '../overlay.js';
import {selectPresentation} from '../position/position.js';
import {controlBase, fieldHover, focusRing, hostTypography} from '../styles/base.js';
import {MNDW_OPTION_CHANGE_EVENT} from './option.js';
import {type OptionModel, readOptions} from './option-model.js';
import {SelectPopoverTracker, applySelectPopoverSizing} from './select-popover.js';
import {
  MNDW_SELECT_PANEL_TAG,
  type MndwSelectPanel,
  type PanelDismissDetail,
  type PanelSelectDetail,
} from './select-panel.js';

export const MNDW_SELECT_TAG = 'mndw-select';

export interface MndwSelectChangeDetail {
  value: string;
}

type SelectOpenFocus = 'selected' | 'first' | 'last';

export class MndwSelect extends LitElement {
  public static readonly formAssociated = true;

  /** A non-empty `label` is the accessible name; its children are options, never labels. */
  public static readonly mndwLabelSource: MndwLabelSource = 'label-property';

  public static readonly properties: PropertyDeclarations = {
    value: {type: String},
    placeholder: {type: String},
    disabled: {type: Boolean, reflect: true},
    required: {type: Boolean, reflect: true},
    invalid: {type: Boolean, reflect: true},
    name: {type: String, reflect: true},
    panelClass: {type: String, attribute: 'panel-class'},
    label: {type: String},
    open: {type: Boolean, state: true},
  };

  public static readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-block;
      width: 100%;
      border-radius: var(--mndw-radius-md);
    }

    :host([disabled]) {
      pointer-events: none;
      opacity: 0.5;
    }

    [part='trigger'] {
      ${controlBase}

      display: flex;
      gap: var(--mndw-space-2);
      align-items: center;
      justify-content: space-between;
      width: 100%;
      border: 1px solid var(--mndw-border);
      background: var(--mndw-surface-raised);
      color: var(--mndw-text);
      text-align: left;
      cursor: pointer;
    }

    :host(:not([disabled]):not([invalid]):not([aria-invalid='true'])) [part='trigger']:hover {
      ${fieldHover}
    }

    :host(:focus-visible) {
      ${focusRing}
    }

    .value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .value.placeholder {
      color: var(--mndw-text-subtle);
    }

    .indicator {
      flex-shrink: 0;
      color: var(--mndw-text-subtle);
    }
  `;

  declare public value: string;
  declare public placeholder: string | undefined;
  declare public disabled: boolean;
  declare public required: boolean;
  declare public invalid: boolean;
  declare public name: string;
  declare public panelClass: string;
  declare public label: string;
  declare public open: boolean;

  private layer: UiLayer | null = null;
  private panel: MndwSelectPanel | null = null;
  private cancelInitialFocusRetry: (() => void) | null = null;
  private panelHadFocus = false;
  private presentation: UiLayerPresentation | null = null;
  private readonly placeholderState: LocalizedPropertyState<string | undefined>;
  private readonly localeController = new LocaleController(this, {
    applyLocale: (): void => {
      this.applyLocale();
    },
  });
  private readonly formState = new FormAssociatedController(this, {
    isExplicitlyDisabled: () => this.disabled,
    onReset: () => this.resetForm(),
    onStateRestore: (state) => this.restoreFormState(state),
    onDisabledChange: () => {
      this.requestUpdate();
    },
  });
  private readonly labelController = new FormLabelController(this);
  private readonly popoverTracker = new SelectPopoverTracker({
    isActive: () => this.presentation === 'popover' && this.layer !== null,
    isConnected: () => this.layer?.contentElement.isConnected === true,
    readAnchorRect: () => this.getBoundingClientRect(),
    onGeometryChange: (rect) => {
      if (this.layer !== null) {
        this.applyPopoverSizing(this.layer, rect);
      }
    },
    onReposition: () => this.layer?.reposition(),
  });

  constructor() {
    super();
    this.placeholderState = createLocalizedProperty<string | undefined>(this, 'placeholder');
    this.value = '';
    this.disabled = false;
    this.required = false;
    this.invalid = false;
    this.name = '';
    this.panelClass = '';
    this.label = '';
    this.open = false;
    this.addEventListener('click', this.onTriggerClick);
    this.addEventListener('keydown', this.onTriggerKeydown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.formState.captureInitialAttributes(['value']);
    this.addEventListener(MNDW_OPTION_CHANGE_EVENT, this.onOptionChange);
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener(MNDW_OPTION_CHANGE_EVENT, this.onOptionChange);
    this.closePanel(false);
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

  public refreshAccessibleName(): void {
    this.requestUpdate();
  }

  protected override render(): TemplateResult {
    const selected = this.options().find((option) => option.value === this.value);

    return html`
      <div
        part="trigger"
        aria-hidden="true"
        @keydown=${this.onTriggerKeydown}
      >
        <span class="value ${selected ? '' : 'placeholder'}" part="value">
          ${selected ? selected.label : this.placeholder ?? getMndwUiText('select.placeholder')}
        </span>
        <span class="indicator" part="indicator" aria-hidden="true"><mndw-icon name="chevron-down"></mndw-icon></span>
      </div>
      <slot hidden @slotchange=${this.onSlotChange}></slot>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    const effectiveDisabled = this.formState.effectiveDisabled;
    const selected = this.options().find((option) => option.value === this.value);
    const submittedValue = selected ? selected.value : null;

    this.setAttribute('role', 'combobox');
    this.setAttribute('aria-haspopup', 'listbox');
    this.setAttribute('aria-expanded', String(this.open));
    this.setAttribute('aria-disabled', String(effectiveDisabled));
    this.setAttribute('aria-required', String(this.required));
    this.tabIndex = effectiveDisabled ? -1 : 0;

    if (this.formState.internals) {
      this.formState.internals.ariaLabel = this.label || null;
      this.formState.internals.ariaExpanded = String(this.open);
      this.formState.internals.ariaHasPopup = 'listbox';
      this.formState.internals.ariaDisabled = String(effectiveDisabled);
      this.formState.internals.ariaRequired = String(this.required);

      if (this.label) {
        this.setAttribute('aria-label', this.label);
        this.removeAttribute('aria-labelledby');
        this.formState.internals.ariaLabelledByElements = [];
      } else {
        this.removeAttribute('aria-label');

        const labels = this.formState.labels;

        this.labelController.sync(labels, this.formState.internals);
      }
    } else if (this.label) {
      this.setAttribute('aria-label', this.label);
    } else {
      this.removeAttribute('aria-label');
    }

    this.formState.setFormValue(submittedValue, this.value);

    if (this.required && !selected) {
      this.formState.setValidity({valueMissing: true}, getMndwUiText('select.validation.required'));
    } else {
      this.formState.clearValidity();
    }

    const invalid = this.invalid
      || (this.required && !selected)
      || (this.formState.internals?.validity?.valid === false);

    this.setAttribute('aria-invalid', String(invalid));

    if (this.formState.internals) {
      this.formState.internals.role = 'combobox';
      this.formState.internals.ariaInvalid = String(invalid);
    }

    // A label source that changes after mount would leave a wrapping field's suppression stale.
    if (changed.has('label') && changed.get('label') !== undefined) {
      dispatchLabelChange(this);
    }
  }

  private options(): OptionModel[] {
    return readOptions(this);
  }

  private applyLocale(): void {
    this.placeholderState.setGenerated(getMndwUiText('select.placeholder'));
    this.layer?.setTitle?.(this.label || getMndwUiText('select.overlay.title'));
  }

  private readonly onSlotChange = (): void => {
    this.syncOptions();
  };

  private readonly onOptionChange = (): void => {
    this.syncOptions();
  };

  private syncOptions(): void {
    this.requestUpdate();

    if (this.panel) {
      this.panel.options = this.options();
    }
  }

  private onTriggerClick = (): void => {
    if (this.open) {
      this.closePanel(true);

      return;
    }

    this.openPanel();
  };

  private onTriggerKeydown = (event: KeyboardEvent): void => {
    const fromShadowTrigger = event.currentTarget !== this;

    if (!['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();

    if (!this.open) {
      const focus: SelectOpenFocus = event.key === 'Home'
        ? 'first'
        : event.key === 'End'
        ? 'last'
        : 'selected';

      this.openPanel(focus);
    }

    if (fromShadowTrigger) {
      event.stopPropagation();
    }
  };

  private openPanel(focus: SelectOpenFocus = 'selected'): void {
    if (this.formState.effectiveDisabled || this.open || !this.isConnected) {
      return;
    }

    const presentation = selectPresentation(window.innerWidth);
    const layer = getOverlayProvider().open({
      anchor: this,
      presentation,
      title: this.label || getMndwUiText('select.overlay.title'),
      className: this.panelClass || undefined,
    });

    if (presentation === 'popover') {
      this.applyPopoverSizing(layer);
      window.addEventListener('resize', this.onViewportChange);
      window.addEventListener('scroll', this.onViewportChange, true);
    }

    const panel = document.createElement(MNDW_SELECT_PANEL_TAG);

    panel.options = this.options();
    panel.value = this.value;
    panel.label = this.label;
    panel.sheet = presentation === 'sheet';
    panel.addEventListener('mndwpanelselect', this.onPanelSelect);
    panel.addEventListener('mndwpaneldismiss', this.onPanelDismiss);
    panel.addEventListener('focusout', this.onPanelFocusOut);
    layer.contentElement.appendChild(panel);

    if (this.formState.internals && 'ariaControlsElements' in this.formState.internals) {
      this.formState.internals.ariaControlsElements = [panel];
    }

    this.layer = layer;
    this.panel = panel;
    this.presentation = presentation;
    this.open = true;

    if (presentation === 'popover') {
      this.startPopoverTracking();
    }

    void panel.updateComplete.then(() => {
      if (this.layer !== layer) {
        return;
      }

      if (focus === 'first') {
        panel.activeIndex = this.firstEnabledIndex(panel.options);
      } else if (focus === 'last') {
        panel.activeIndex = this.lastEnabledIndex(panel.options);
      }

      this.cancelInitialFocusRetry = focusWithinWithRetry(
        panel,
        () => panel.focusActive(),
        () => this.layer === layer,
        () => {
          this.panelHadFocus = true;
        },
      );
    });

    void layer.closed.then((reason) => {
      if (this.layer !== layer) {
        return;
      }

      const hadFocus = this.panelHadFocus;

      this.forgetLayer();
      this.restoreFocus(reason, hadFocus);
    });
  }

  private applyPopoverSizing(layer: UiLayer, rect = this.getBoundingClientRect()): void {
    applySelectPopoverSizing(layer.contentElement, rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }

  private startPopoverTracking(): void {
    this.popoverTracker.start();
  }

  private cancelPopoverTracking(): void {
    this.popoverTracker.cancel();
  }

  private readonly onViewportChange = (): void => {
    const layer = this.layer;

    if (this.presentation !== 'popover' || !layer) {
      return;
    }

    this.applyPopoverSizing(layer);
    layer.reposition();
  };

  private restoreFocus(reason: UiCloseReason, hadFocus: boolean): void {
    if (reason === 'detached' || !this.isConnected) {
      return;
    }

    const active = deepActiveElement();
    const orphaned = active === null || active === document.body;

    if (!hadFocus && !orphaned) {
      return;
    }

    this.focus();
  }

  private readonly onPanelFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;

    if (next instanceof Node && this.panel?.contains(next) !== true) {
      this.panelHadFocus = false;
    }
  };

  private readonly onPanelSelect = (event: Event): void => {
    const detail = (event as CustomEvent<PanelSelectDetail>).detail;

    this.value = detail.value;
    this.closePanel(true);
    this.dispatchEvent(
      new CustomEvent<MndwSelectChangeDetail>('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: detail.value},
      }),
    );
  };

  private readonly onPanelDismiss = (event: Event): void => {
    const detail = (event as CustomEvent<PanelDismissDetail>).detail;

    this.closePanel(detail.restoreFocus);
  };

  private closePanel(wantsFocus: boolean): void {
    const layer = this.layer;

    if (!layer) {
      return;
    }

    const hadFocus = this.panelHadFocus;

    this.forgetLayer();
    layer.close();

    if (wantsFocus) {
      this.restoreFocus('api', hadFocus);
    }
  }

  private forgetLayer(): void {
    this.cancelInitialFocusRetry?.();
    this.cancelInitialFocusRetry = null;
    this.cancelPopoverTracking();
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
    this.panel?.removeEventListener('mndwpanelselect', this.onPanelSelect);
    this.panel?.removeEventListener('mndwpaneldismiss', this.onPanelDismiss);
    this.panel?.removeEventListener('focusout', this.onPanelFocusOut);

    if (this.formState.internals && 'ariaControlsElements' in this.formState.internals) {
      this.formState.internals.ariaControlsElements = [];
    }

    this.panel = null;
    this.layer = null;
    this.presentation = null;
    this.open = false;
    this.panelHadFocus = false;
  }

  private firstEnabledIndex(options: OptionModel[]): number {
    return options.findIndex((option) => !option.disabled);
  }

  private lastEnabledIndex(options: OptionModel[]): number {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index].disabled) {
        return index;
      }
    }

    return -1;
  }

  private resetForm(): void {
    this.value = this.getAttribute('value') ?? this.options()[0]?.value ?? '';
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
    'mndw-select': MndwSelect;
  }
}
