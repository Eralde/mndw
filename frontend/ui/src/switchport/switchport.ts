import {
  LitElement,
  type PropertyDeclarations,
  type SVGTemplateResult,
  type TemplateResult,
  css,
  html,
  nothing,
  svg,
} from 'lit';

export const MNDW_SWITCHPORT_TAG = 'mndw-switchport';

export type MndwSwitchportType = 'ethernet' | 'sfp' | 'dsl';

export type MndwSwitchportColor = 'blue' | 'gray' | 'orange';

export type MndwSwitchportCombo = 'none' | 'ethernet-sfp' | 'sfp-ethernet';

export type MndwSwitchportMedium = 'ethernet' | 'sfp';

/** Socket art is drawn in the mockup's 56x52 box and scales with the host. */
const SOCKET_WIDTH = 56;
const ART_HEIGHT = 52;
/** Every socket shares this outer box so mixed rows line up at the top and the bottom. */
const SOCKET_TOP = 7;
const SOCKET_BOTTOM = 46;
const SOCKET_CENTER_Y = (SOCKET_TOP + SOCKET_BOTTOM) / 2;
/** One baseline for the case label in every socket type, upright or reversed. */
const LABEL_Y = 34;
const LABEL_Y_REVERSED = 29;
/** The SFP slot sits this far inside the cage on every side. */
const SFP_SLOT_INSET = 3;
const COMBO_GAP = 4;
const COMBO_WIDTH = SOCKET_WIDTH * 2 + COMBO_GAP;
const LED_WIDTH = 6;
const LED_HEIGHT = 3;
/** Inset from the top so a caller's box never clips the LED. */
const LED_Y = 1;

const isSwitchportType = (value: string): value is MndwSwitchportType =>
  value === 'ethernet' || value === 'sfp' || value === 'dsl';

const isSwitchportColor = (value: string): value is MndwSwitchportColor =>
  value === 'blue' || value === 'gray' || value === 'orange';

const isSwitchportCombo = (value: string): value is MndwSwitchportCombo =>
  value === 'none' || value === 'ethernet-sfp' || value === 'sfp-ethernet';

const isSwitchportMedium = (value: string): value is MndwSwitchportMedium => value === 'ethernet' || value === 'sfp';

interface SocketOptions {
  readonly dim: boolean;
  readonly label: string;
}

/**
 * Decorative port art for Ethernet, SFP, DSL, and combo ports. It only draws: the caller wraps it
 * in a button and owns the accessible name, so the host is hidden from assistive technology.
 */
export class MndwSwitchport extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    type: {type: String, reflect: true},
    color: {type: String, reflect: true},
    label: {type: String, reflect: true},
    reversed: {type: Boolean, reflect: true},
    combo: {type: String, reflect: true},
    active: {type: String, reflect: true},
    link: {type: Boolean, reflect: true},
    portRole: {type: String, reflect: true, attribute: 'port-role'},
    selected: {type: Boolean, reflect: true},
    disabled: {type: Boolean, reflect: true},
  };

  public static override readonly styles = css`
    /* --_mndw-* are component-local values, not a caller API. */
    :host {
      display: inline-block;
      font-family: var(--mndw-font-sans);
      line-height: 0;
    }

    .port {
      display: block;
      height: var(--_mndw-switchport-size, 3.5em);
      width: auto;
      overflow: visible;
    }

    .port[data-disabled] {
      opacity: 0.45;
    }

    .socket {
      stroke-linejoin: round;
    }

    .socket[data-dim] > .socket-shape {
      opacity: 0.4;
    }

    .ethernet {
      stroke-width: 1.4;
    }

    .ethernet[data-color='blue'] {
      fill: var(--_mndw-switchport-blue-fill, color-mix(in srgb, var(--mndw-accent) 20%, var(--mndw-surface)));
      stroke: var(--_mndw-switchport-blue-line, var(--mndw-accent));
    }

    .ethernet[data-color='gray'] {
      fill: var(--_mndw-switchport-gray-fill, var(--mndw-surface-raised));
      stroke: var(--_mndw-switchport-gray-line, var(--mndw-border));
    }

    .ethernet[data-color='orange'] {
      fill: var(--_mndw-switchport-orange-fill, color-mix(in srgb, var(--mndw-warning) 20%, var(--mndw-surface)));
      stroke: var(--_mndw-switchport-orange-line, var(--mndw-warning));
    }

    .sfp-cage,
    .dsl {
      fill: var(--_mndw-switchport-gray-fill, var(--mndw-surface-raised));
      stroke: var(--_mndw-switchport-gray-line, var(--mndw-border));
      stroke-width: 1.4;
    }

    .sfp-slot {
      fill: none;
      stroke: var(--_mndw-switchport-gray-line, var(--mndw-border));
      stroke-width: 1;
    }

    .frame {
      fill: none;
      stroke: var(--_mndw-switchport-frame, var(--mndw-border));
      stroke-dasharray: 3 2;
    }

    .selected {
      fill: none;
      stroke: var(--_mndw-switchport-selected, var(--mndw-accent));
      stroke-width: 1.4;
    }

    .led {
      fill: transparent;
    }

    .led[data-on='true'] {
      fill: var(--_mndw-switchport-led, var(--mndw-success));
    }

    .badge {
      fill: var(--_mndw-switchport-badge-bg, var(--mndw-surface-raised));
      stroke: var(--_mndw-switchport-badge-line, var(--mndw-border));
    }

    .badge-ink {
      fill: none;
      stroke: var(--_mndw-switchport-badge-ink, var(--mndw-text-muted));
      stroke-width: 1;
    }

    .label {
      fill: var(--mndw-text);
      font-weight: 600;
      text-anchor: middle;
    }
  `;

  declare public type: MndwSwitchportType;
  declare public color: MndwSwitchportColor;
  declare public label: string;
  declare public reversed: boolean;
  declare public combo: MndwSwitchportCombo;
  declare public active: MndwSwitchportMedium | '';
  declare public link: boolean;
  declare public portRole: string;
  declare public selected: boolean;
  declare public disabled: boolean;

  constructor() {
    super();
    this.type = 'ethernet';
    this.color = 'gray';
    this.label = '';
    this.reversed = false;
    this.combo = 'none';
    this.active = '';
    this.link = false;
    this.portRole = '';
    this.selected = false;
    this.disabled = false;
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('aria-hidden', 'true');
  }

  protected override render(): TemplateResult {
    const width = this.resolvedCombo === 'none' ? SOCKET_WIDTH : COMBO_WIDTH;

    return html`
      <svg
        part="port"
        class="port"
        viewBox="0 0 ${width} ${ART_HEIGHT}"
        aria-hidden="true"
        focusable="false"
        ?data-disabled=${this.disabled}
      >
        ${this.resolvedCombo === 'none' ? this.renderSingle() : this.renderCombo()}
      </svg>
    `;
  }

  /** Unknown values fall back to the documented default rather than rendering an empty socket. */
  private get resolvedType(): MndwSwitchportType {
    return isSwitchportType(this.type) ? this.type : 'ethernet';
  }

  private get resolvedColor(): MndwSwitchportColor {
    return isSwitchportColor(this.color) ? this.color : 'gray';
  }

  private get resolvedCombo(): MndwSwitchportCombo {
    return isSwitchportCombo(this.combo) ? this.combo : 'none';
  }

  private get resolvedActive(): MndwSwitchportMedium | '' {
    if (this.resolvedCombo === 'none' || !isSwitchportMedium(this.active)) {
      return '';
    }

    return this.active;
  }

  private renderSingle(): SVGTemplateResult {
    return svg`
      ${this.renderSelection(SOCKET_WIDTH)}
      ${this.renderLed(SOCKET_WIDTH / 2, this.link)}
      ${this.renderSocket(this.resolvedType, 0, {dim: false, label: this.label})}
      ${this.portRole === 'inet' ? this.renderGlobe(SOCKET_WIDTH - 7, ART_HEIGHT - 7) : nothing}
    `;
  }

  private renderCombo(): SVGTemplateResult {
    const order: readonly MndwSwitchportMedium[] = this.resolvedCombo === 'ethernet-sfp'
      ? ['ethernet', 'sfp']
      : ['sfp', 'ethernet'];
    const active = this.resolvedActive;
    const activeIndex = active === '' ? -1 : order.indexOf(active);
    const ledX = activeIndex === 0 ? SOCKET_WIDTH / 2 : COMBO_GAP + SOCKET_WIDTH + SOCKET_WIDTH / 2;
    const globe = this.portRole === 'inet' ? this.renderGlobe(COMBO_WIDTH - 8, ART_HEIGHT - 7) : nothing;

    return svg`
      ${this.renderSelection(COMBO_WIDTH)}
      <rect
        part="frame"
        class="frame"
        x="2"
        y="5"
        width=${COMBO_WIDTH - 4}
        height="45"
        rx="5"
      ></rect>
      ${activeIndex < 0 ? nothing : this.renderLed(ledX, this.link)}
      ${
      order.map((kind, index) =>
        this.renderSocket(kind, index === 0 ? 0 : SOCKET_WIDTH + COMBO_GAP, {
          dim: active !== kind,
          label: kind === 'ethernet' ? this.label : '',
        })
      )
    }
      ${globe}
    `;
  }

  private renderSocket(kind: MndwSwitchportType, offsetX: number, options: SocketOptions): SVGTemplateResult {
    const shift = offsetX === 0 ? nothing : `translate(${offsetX} 0)`;

    return svg`
      <g part="socket" class="socket" data-kind=${kind} ?data-dim=${options.dim} transform=${shift}>
        ${kind === 'ethernet' ? this.renderEthernet(options.label) : nothing}
        ${kind === 'sfp' ? this.renderSfp(options.label) : nothing}
        ${kind === 'dsl' ? this.renderDsl(options.label) : nothing}
      </g>
    `;
  }

  private renderEthernet(label: string): SVGTemplateResult {
    const rotation = this.reversed ? `rotate(180 28 ${SOCKET_CENTER_Y})` : nothing;

    return svg`
      <g class="socket-shape" transform=${rotation}>
        <path
          part="ethernet"
          class="ethernet"
          data-color=${this.resolvedColor}
          d="M6 16h10v-5h6V${SOCKET_TOP}h12v4h6v5h10V${SOCKET_BOTTOM}H6z"
        ></path>
      </g>
      ${this.renderLabel(label, 28, this.labelBaseline)}
    `;
  }

  private renderSfp(label: string): SVGTemplateResult {
    const rotation = this.reversed ? `rotate(180 28 ${SOCKET_CENTER_Y})` : nothing;
    const cageWidth = 44;
    const cageHeight = SOCKET_BOTTOM - SOCKET_TOP;

    return svg`
      <g class="socket-shape" transform=${rotation}>
        <rect part="sfp" class="sfp-cage" x="6" y=${SOCKET_TOP} width=${cageWidth} height=${cageHeight} rx="2"></rect>
        <rect
          class="sfp-slot"
          x=${6 + SFP_SLOT_INSET}
          y=${SOCKET_TOP + SFP_SLOT_INSET}
          width=${cageWidth - SFP_SLOT_INSET * 2}
          height=${cageHeight - SFP_SLOT_INSET * 2}
          rx="1"
        ></rect>
      </g>
      ${this.renderLabel(label, 28, this.labelBaseline)}
    `;
  }

  private renderDsl(label: string): SVGTemplateResult {
    const rotation = this.reversed ? `rotate(180 28 ${SOCKET_CENTER_Y})` : nothing;

    return svg`
      <g class="socket-shape" transform=${rotation}>
        <path part="dsl" class="dsl" d="M12 16h7v-4h4V${SOCKET_TOP}h10v5h4v4h7V${SOCKET_BOTTOM}H12z"></path>
      </g>
      ${this.renderLabel(label, 28, this.labelBaseline)}
    `;
  }

  private get labelBaseline(): number {
    return this.reversed ? LABEL_Y_REVERSED : LABEL_Y;
  }

  private renderLabel(label: string, centerX: number, baselineY: number): SVGTemplateResult | '' {
    if (label === '') {
      return '';
    }

    return svg`
      <text part="label" class="label" x=${centerX} y=${baselineY} font-size="12">${label}</text>
    `;
  }

  private renderLed(centerX: number, on: boolean): SVGTemplateResult {
    return svg`
      <rect
        part="led"
        class="led"
        data-on=${String(on)}
        x=${centerX - LED_WIDTH / 2}
        y=${LED_Y}
        width=${LED_WIDTH}
        height=${LED_HEIGHT}
        rx="1"
      ></rect>
    `;
  }

  private renderGlobe(centerX: number, centerY: number): SVGTemplateResult {
    return svg`
      <g part="globe" transform=${`translate(${centerX} ${centerY})`}>
        <circle class="badge" r="7.5"></circle>
        <circle class="badge-ink" r="4.5"></circle>
        <ellipse class="badge-ink" rx="2" ry="4.5"></ellipse>
        <path class="badge-ink" d="M-4.5 0h9"></path>
      </g>
    `;
  }

  private renderSelection(width: number): SVGTemplateResult | '' {
    if (!this.selected) {
      return '';
    }

    return svg`
      <rect part="selected" class="selected" x="0.5" y="0.5" width=${width - 1} height=${ART_HEIGHT - 1} rx="4"></rect>
    `;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-switchport': MndwSwitchport;
  }
}
