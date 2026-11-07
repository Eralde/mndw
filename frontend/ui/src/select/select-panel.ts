import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import {repeat} from 'lit/directives/repeat.js';
import {focusRing, hostTypography, surfaceHover} from '../styles/base.js';
import type {OptionModel} from './option-model.js';

export const MNDW_SELECT_PANEL_TAG = 'mndw-select-panel';

let nextPanelId = 0;

export interface PanelSelectDetail {
  value: string;
}

export interface PanelDismissDetail {
  restoreFocus: boolean;
  defer?: boolean;
}

export class MndwSelectPanel extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    options: {type: Array},
    value: {type: String},
    label: {type: String},
    sheet: {type: Boolean, reflect: true},
    activeIndex: {type: Number, state: true},
  };

  public static readonly styles = css`
    :host {
      ${hostTypography}

      box-sizing: border-box;
      display: flex;
      flex: 0 1 auto;
      flex-direction: column;
      min-height: 0;
      width: 100%;
      max-width: 100%;
      overflow: hidden;
      border: var(--mndw-border-w) solid var(--mndw-border);
      border-radius: var(--mndw-radius-md);
      background: var(--mndw-surface-raised);
      box-shadow: var(--mndw-shadow-2);
    }

    mndw-scroll-area {
      flex: 0 1 auto;
      min-height: 0;
    }

    .listbox {
      padding: var(--mndw-space-1);
      padding-inline-end: calc(var(--mndw-space-1) + var(--mndw-scrollbar-size));
      font-family: inherit;
      font-size: inherit;
    }

    .listbox:focus-visible {
      ${focusRing}
      outline-offset: -2px;
    }

    :host([sheet]) {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border: none;
      border-radius: 0;
      box-shadow: none;
    }

    .option {
      display: flex;
      gap: var(--mndw-space-2);
      align-items: center;
      justify-content: space-between;
      padding: var(--mndw-space-2) var(--mndw-space-3);
      border-radius: var(--mndw-radius-sm);
      color: var(--mndw-text);
      cursor: pointer;
    }

    .option:not([aria-disabled='true']):hover {
      ${surfaceHover}
    }

    .option[aria-selected='true'] {
      color: var(--mndw-accent);
    }

    .option[aria-disabled='true'] {
      color: var(--mndw-text-subtle);
      cursor: not-allowed;
    }
  `;

  declare public options: OptionModel[];
  declare public value: string;
  declare public label: string;
  declare public sheet: boolean;
  declare public activeIndex: number;

  private readonly panelId = nextPanelId++;

  constructor() {
    super();
    this.options = [];
    this.value = '';
    this.label = '';
    this.sheet = false;
    this.activeIndex = -1;
  }

  public get listboxElement(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('[role="listbox"]');
  }

  public get activeOptionElement(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(`#${this.optionId(this.activeIndex)}`);
  }

  public focusListbox(): void {
    this.listboxElement?.focus();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('options') || changed.has('value')) {
      const selected = this.options.findIndex((option) => option.value === this.value);

      this.activeIndex = selected >= 0 && !this.options[selected]?.disabled ? selected : this.firstEnabledIndex();
    }
  }

  protected override render(): TemplateResult {
    return html`
      <mndw-scroll-area exportparts="viewport,scrollbar,track,thumb">
        <div
          class="listbox"
          part="listbox"
          role="listbox"
          aria-label=${this.label}
          aria-activedescendant=${this.optionId(this.activeIndex)}
          tabindex="0"
        >
          ${
      repeat(
        this.options,
        (option, index) => `${index}:${option.value}`,
        (option, index) => {
          const labelHtml = option.labelNodes.length > 0
            ? option.labelNodes.map((node) => node.cloneNode(true))
            : option.label;

          return html`
              <div
                class="option"
                part="option"
                role="option"
                id=${this.optionId(index)}
                aria-selected=${String(index === this.activeIndex)}
                aria-disabled=${String(option.disabled)}
                @click=${() => this.select(index)}
              >
                <span>${labelHtml}</span>
                ${index === this.activeIndex ? html`<mndw-icon name="check" aria-hidden="true"></mndw-icon>` : null}
              </div>
            `;
        },
      )
    }
        </div>
      </mndw-scroll-area>
    `;
  }

  private firstEnabledIndex(): number {
    return this.options.findIndex((option) => !option.disabled);
  }

  private optionId(index: number): string {
    return `mndw-select-${this.panelId}-option-${index}`;
  }

  private select(index: number): void {
    const option = this.options[index];

    if (!option || option.disabled) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent<PanelSelectDetail>('mndwpanelselect', {detail: {value: option.value}}),
    );
  }

  private dismiss(): void {
    this.dispatchEvent(
      new CustomEvent<PanelDismissDetail>('mndwpaneldismiss', {detail: {restoreFocus: true}}),
    );
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-select-panel': MndwSelectPanel;
  }
}
