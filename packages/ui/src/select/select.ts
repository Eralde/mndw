import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import {deepActiveElement} from '../focus.js';
import {type UiCloseReason, type UiLayer, type UiLayerPresentation, getOverlayProvider} from '../overlay.js';
import {controlBase, focusRing, hostTypography} from '../styles/base.js';
import {MNDW_OPTION_CHANGE_EVENT} from './option.js';
import {type OptionModel, readOptions} from './option-model.js';
import {SELECT_VIEWPORT_PADDING, availablePopoverHeight, selectPresentation} from './select-position.js';
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

const PANEL_MIN_WIDTH = 180;

export class MndwSelect extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    value: {type: String},
    placeholder: {type: String},
    disabled: {type: Boolean, reflect: true},
    panelClass: {type: String, attribute: 'panel-class'},
    label: {type: String},
    open: {type: Boolean, state: true},
  };

  public static readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-block;
      width: 100%;
    }

    :host([disabled]) {
      pointer-events: none;
      opacity: 0.5;
    }

    button {
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

    button:focus-visible {
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
  declare public placeholder: string;
  declare public disabled: boolean;
  declare public panelClass: string;
  declare public label: string;
  declare public open: boolean;

  private layer: UiLayer | null = null;
  private panel: MndwSelectPanel | null = null;
  private panelHadFocus = false;
  private presentation: UiLayerPresentation | null = null;

  constructor() {
    super();
    this.value = '';
    this.placeholder = 'Select…';
    this.disabled = false;
    this.panelClass = '';
    this.label = '';
    this.open = false;
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener(MNDW_OPTION_CHANGE_EVENT, this.onOptionChange);
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener(MNDW_OPTION_CHANGE_EVENT, this.onOptionChange);
    this.closePanel(false);
  }

  protected override render(): TemplateResult {
    const selected = this.options().find((option) => option.value === this.value);

    return html`
      <button
        part="trigger"
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded=${String(this.open)}
        aria-label=${this.label}
        aria-disabled=${String(this.disabled)}
        @click=${this.onTriggerClick}
        @keydown=${this.onTriggerKeydown}
      >
        <span class="value ${selected ? '' : 'placeholder'}" part="value">
          ${selected ? selected.label : this.placeholder}
        </span>
        <span class="indicator" part="indicator" aria-hidden="true">▾</span>
      </button>
      <slot hidden @slotchange=${this.onSlotChange}></slot>
    `;
  }

  private options(): OptionModel[] {
    return readOptions(this);
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
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();

    if (!this.open) {
      this.openPanel();
    }
  };

  private triggerElement(): HTMLButtonElement | null {
    return this.renderRoot.querySelector('button');
  }

  private openPanel(): void {
    const anchor = this.triggerElement();

    if (this.disabled || this.open || !anchor) {
      return;
    }

    const presentation = selectPresentation(window.innerWidth);
    const layer = getOverlayProvider().open({
      anchor,
      presentation,
      title: this.label || 'Select option',
    });

    if (presentation === 'popover') {
      this.applyPopoverSizing(layer, anchor);
      window.addEventListener('resize', this.onViewportChange);
      window.addEventListener('scroll', this.onViewportChange, true);
    }

    const panel = document.createElement(MNDW_SELECT_PANEL_TAG) as MndwSelectPanel;

    if (this.panelClass) {
      panel.classList.add(...this.panelClass.split(/\s+/).filter(Boolean));
    }

    panel.options = this.options();
    panel.value = this.value;
    panel.label = this.label;
    panel.sheet = presentation === 'sheet';
    panel.addEventListener('mndwpanelselect', this.onPanelSelect);
    panel.addEventListener('mndwpaneldismiss', this.onPanelDismiss);
    panel.addEventListener('focusout', this.onPanelFocusOut);
    layer.contentElement.appendChild(panel);

    this.layer = layer;
    this.panel = panel;
    this.presentation = presentation;
    this.open = true;

    void panel.updateComplete.then(() => {
      if (this.layer !== layer) {
        return;
      }

      if (presentation === 'popover') {
        layer.reposition();
      }

      panel.focusActive();
      this.panelHadFocus = true;
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

  private applyPopoverSizing(layer: UiLayer, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();

    layer.contentElement.style.minWidth = `${Math.max(rect.width, PANEL_MIN_WIDTH)}px`;
    layer.contentElement.style.maxWidth = `calc(100vw - ${SELECT_VIEWPORT_PADDING * 2}px)`;
    layer.contentElement.style.maxHeight = `${
      availablePopoverHeight(rect, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }px`;
    layer.contentElement.style.overflowY = 'auto';
  }

  private readonly onViewportChange = (): void => {
    const layer = this.layer;
    const anchor = this.triggerElement();

    if (this.presentation !== 'popover' || !layer || !anchor) {
      return;
    }

    this.applyPopoverSizing(layer, anchor);
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

    this.triggerElement()?.focus();
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
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
    this.panel?.removeEventListener('mndwpanelselect', this.onPanelSelect);
    this.panel?.removeEventListener('mndwpaneldismiss', this.onPanelDismiss);
    this.panel?.removeEventListener('focusout', this.onPanelFocusOut);
    this.panel = null;
    this.layer = null;
    this.presentation = null;
    this.open = false;
    this.panelHadFocus = false;
  }
}
