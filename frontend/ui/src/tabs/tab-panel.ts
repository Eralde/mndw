import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import {hostTypography} from '../styles/base.js';

export const MNDW_TAB_PANEL_TAG = 'mndw-tab-panel';

let nextPanelId = 0;

/**
 * The content half of a tab pair. `for` points at its tab — the opposite direction to
 * `<label for>` — so tabs can be reordered or conditionally rendered without every panel
 * reference breaking.
 */
export class MndwTabPanel extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    for: {type: String, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: block;
      padding: var(--mndw-space-3) 0;
      color: var(--mndw-text);
    }

    :host([hidden]) {
      display: none;
    }
  `;

  declare public for: string;

  constructor() {
    super();
    this.for = '';
  }

  public override connectedCallback(): void {
    super.connectedCallback();

    // The tab needs something to point `aria-controls` at, and a generated id has to survive
    // re-renders to keep that reference stable.
    if (this.id === '') {
      nextPanelId += 1;
      this.id = `mndw-tab-panel-${nextPanelId}`;
    }
  }

  protected override render(): TemplateResult {
    return html`
      <div part="panel">
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-tab-panel': MndwTabPanel;
  }
}
