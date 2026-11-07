import {LitElement, type PropertyDeclarations, type PropertyValues, type TemplateResult, css, html, nothing} from 'lit';
import {type MndwLabelSource, dispatchLabelChange} from '../field/field.js';
import {deepActiveElement, tabbableElements} from '../focus.js';
import {AriaKeyManager, type KeyManagerList} from '../aria/key-manager.js';
import {FormAssociatedController} from '../forms/form-associated.js';
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

type SelectOpenFocus = 'selected' | 'first' | 'last' | 'active';

export class MndwSelect extends LitElement {
  public static readonly formAssociated = true;

  public static override readonly shadowRootOptions = {...LitElement.shadowRootOptions, delegatesFocus: true};

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

    [part='trigger']:focus-visible {
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
  private presentation: UiLayerPresentation | null = null;
  private readonly keyManager = new AriaKeyManager<OptionModel>({
    getLabel: (option) => option.label,
    isDisabled: (option) => option.disabled,
  });
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

  public override focus(options?: FocusOptions): void {
    this.triggerElement()?.focus(options);
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
    const effectiveDisabled = this.formState.effectiveDisabled;
    const invalid = this.isInvalid(selected);

    return html`
      <button
        type="button"
        part="trigger"
        aria-label=${this.triggerLabel() ?? nothing}
        aria-haspopup="listbox"
        aria-expanded=${String(this.open)}
        aria-invalid=${String(invalid)}
        ?disabled=${effectiveDisabled}
      >
        <span class="value ${selected ? '' : 'placeholder'}" part="value">
          ${selected ? selected.label : this.placeholder ?? getMndwUiText('select.placeholder')}
        </span>
        <span class="indicator" part="indicator" aria-hidden="true"><mndw-icon name="chevron-down"></mndw-icon></span>
      </button>
      <slot hidden @slotchange=${this.onSlotChange}></slot>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    const selected = this.options().find((option) => option.value === this.value);
    const submittedValue = selected ? selected.value : null;

    this.formState.setFormValue(submittedValue, this.value);

    if (this.required && !selected) {
      this.formState.setValidity({valueMissing: true}, getMndwUiText('select.validation.required'));
    } else {
      this.formState.clearValidity();
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

  private onTriggerClick = (event: MouseEvent): void => {
    const trigger = this.triggerElement();

    if (trigger !== null && !event.composedPath().includes(trigger)) {
      this.focus();
    }

    if (this.formState.effectiveDisabled) {
      return;
    }

    if (this.open) {
      this.closePanel(true);

      return;
    }

    this.openPanel();
  };

  private onTriggerKeydown = (event: KeyboardEvent): void => {
    if (this.formState.effectiveDisabled) {
      return;
    }

    if (this.open) {
      return;
    }

    let focus: SelectOpenFocus = 'selected';

    switch (event.key) {
      case 'ArrowDown':
        focus = event.altKey ? 'selected' : 'first';
        break;
      case 'ArrowUp':
        focus = 'last';
        break;
      case 'Home':
        focus = 'first';
        break;
      case 'End':
        focus = 'last';
        break;
      case 'Enter':
      case ' ':
        break;
      default: {
        const options = this.options();
        let activeIndex = this.selectedEnabledIndex(options);
        const list: KeyManagerList<OptionModel> = {
          items: options,
          wrap: false,
          mode: 'active-descendant',
          get activeIndex(): number {
            return activeIndex;
          },
          set activeIndex(index: number) {
            activeIndex = index;
          },
          setActiveIndex(index: number): void {
            activeIndex = index;
          },
        };

        if (!this.keyManager.handleKeydown(event, list)) {
          return;
        }

        this.openPanel('active', activeIndex);

        return;
      }
    }

    if (event.altKey && event.key !== 'ArrowDown') {
      return;
    }

    event.preventDefault();
    this.openPanel(focus);
  };

  private handleOpenKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closePanel(true);

      return;
    }

    if (event.key === 'Tab') {
      this.commitActiveOption(event.shiftKey ? 'backward' : 'forward');

      return;
    }

    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      this.commitActiveOption();

      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.commitActiveOption();

      return;
    }

    if (event.altKey || !this.panel) {
      return;
    }

    this.keyManager.handleKeydown(event, this.keyList(this.panel));
  }

  private readonly onPanelKeydown = (event: KeyboardEvent): void => {
    if (this.open) {
      this.handleOpenKeydown(event);
    }
  };

  private openPanel(focus: SelectOpenFocus = 'selected', activeIndex?: number): void {
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
    panel.addEventListener('keydown', this.onPanelKeydown);
    layer.contentElement.appendChild(panel);

    this.layer = layer;
    this.panel = panel;
    this.presentation = presentation;
    this.open = true;

    if (presentation === 'popover') {
      this.startPopoverTracking();
    }

    void panel.updateComplete.then(async () => {
      if (this.layer !== layer) {
        return;
      }

      if (focus === 'active' && activeIndex !== undefined) {
        panel.activeIndex = activeIndex;
      } else if (focus === 'first') {
        panel.activeIndex = this.firstEnabledIndex(panel.options);
      } else if (focus === 'last') {
        panel.activeIndex = this.lastEnabledIndex(panel.options);
      }

      await panel.updateComplete;
      panel.focusListbox();
    });

    void layer.closed.then((reason) => {
      if (this.layer !== layer) {
        return;
      }

      this.forgetLayer();
      this.restoreFocus(reason);
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

  private restoreFocus(reason: UiCloseReason): void {
    if (reason === 'detached' || !this.isConnected) {
      return;
    }

    const active = deepActiveElement();
    const orphaned = active === null || active === document.body;

    if (reason !== 'escape' && !orphaned) {
      return;
    }

    this.focus();
  }

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

  private commitActiveOption(tabDirection?: 'backward' | 'forward'): void {
    const option = this.panel?.options[this.panel.activeIndex];

    if (!option || option.disabled) {
      if (tabDirection === undefined) {
        this.closePanel(true);
      } else {
        this.closePanelAfterTab(tabDirection);
      }

      return;
    }

    this.value = option.value;
    this.dispatchChange(option.value);

    if (tabDirection === undefined) {
      this.closePanel(true);
    } else {
      this.closePanelAfterTab(tabDirection);
    }
  }

  private dispatchChange(value: string): void {
    this.dispatchEvent(
      new CustomEvent<MndwSelectChangeDetail>('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value},
      }),
    );
  }

  private keyList(panel: MndwSelectPanel): KeyManagerList<OptionModel> {
    return {
      items: panel.options,
      wrap: false,
      mode: 'active-descendant',
      get activeIndex(): number {
        return panel.activeIndex;
      },
      set activeIndex(index: number) {
        panel.activeIndex = index;
      },
      setActiveIndex: (index): void => {
        panel.activeIndex = index;
      },
    };
  }

  private closePanelAfterTab(direction: 'backward' | 'forward'): void {
    const layer = this.layer;

    if (layer === null) {
      return;
    }

    const destination = this.tabDestination(direction);

    window.setTimeout(() => {
      if (this.layer !== layer) {
        return;
      }

      this.forgetLayer();
      layer.close();
      void layer.closed.then(() => {
        if (destination?.isConnected) {
          destination.focus();
        }
      });
    }, 0);
  }

  private tabDestination(direction: 'backward' | 'forward'): HTMLElement | null {
    const trigger = this.triggerElement();

    if (trigger === null) {
      return null;
    }

    const tabbable = tabbableElements(document.body);
    const triggerIndex = tabbable.indexOf(trigger);

    if (triggerIndex < 0 || tabbable.length < 2) {
      return null;
    }

    const offset = direction === 'forward' ? 1 : -1;
    const index = (triggerIndex + offset + tabbable.length) % tabbable.length;

    return tabbable[index] ?? null;
  }

  private triggerElement(): HTMLButtonElement | null {
    return this.renderRoot.querySelector<HTMLButtonElement>('[part="trigger"]');
  }

  private triggerLabel(): string | undefined {
    const label = this.label.trim();

    if (label !== '') {
      return label;
    }

    const associatedLabel = this.formState.labels
      .map((item) => item.textContent?.trim() ?? '')
      .filter((text) => text !== '')
      .join(' ');

    return associatedLabel === '' ? undefined : associatedLabel;
  }

  private isInvalid(selected: OptionModel | undefined): boolean {
    return this.invalid || (this.required && !selected);
  }

  private closePanel(wantsFocus: boolean): void {
    const layer = this.layer;

    if (!layer) {
      return;
    }

    this.forgetLayer();
    layer.close();

    if (wantsFocus) {
      this.focus();
    }
  }

  private forgetLayer(): void {
    this.cancelPopoverTracking();
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
    this.panel?.removeEventListener('mndwpanelselect', this.onPanelSelect);
    this.panel?.removeEventListener('mndwpaneldismiss', this.onPanelDismiss);
    this.panel?.removeEventListener('keydown', this.onPanelKeydown);

    this.panel = null;
    this.layer = null;
    this.presentation = null;
    this.open = false;
  }

  private selectedEnabledIndex(options: OptionModel[]): number {
    const selected = options.findIndex((option) => option.value === this.value && !option.disabled);

    return selected >= 0 ? selected : this.firstEnabledIndex(options);
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
