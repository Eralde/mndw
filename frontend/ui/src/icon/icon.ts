import {LitElement, type PropertyDeclarations, type TemplateResult, css, html, nothing, svg} from 'lit';
import {type MndwIconName, isMndwIconName} from './generated/names.js';
import {getIconSpriteUrl, subscribeIconSpriteUrl} from './sprite-config.js';

export const MNDW_ICON_TAG = 'mndw-icon';

const ICON_VIEW_BOX = '0 0 24 24';

/**
 * Renders one symbol from the shared sprite. The sprite URL is host configuration; without it the
 * element renders an empty SVG rather than requesting an asset.
 */
export class MndwIcon extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    name: {type: String, reflect: true},
    label: {type: String, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      display: inline-block;
      width: 1em;
      height: 1em;
      flex: none;
      vertical-align: -0.125em;
    }

    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  declare public name: MndwIconName | '';

  declare public label: string;

  constructor() {
    super();
    this.name = '';
    this.label = '';
  }

  private _unsubscribe: (() => void) | null = null;

  private readonly _onSpriteUrlChange = (): void => {
    this.requestUpdate();
  };

  public override connectedCallback(): void {
    super.connectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = subscribeIconSpriteUrl(this._onSpriteUrlChange);
    this.requestUpdate();
  }

  public override disconnectedCallback(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    super.disconnectedCallback();
  }

  protected override render(): TemplateResult {
    const href = this._href();
    const labelled = this.label !== '';

    return html`
      <svg
        part="svg"
        viewBox=${ICON_VIEW_BOX}
        role="img"
        focusable="false"
        aria-hidden=${labelled ? nothing : 'true'}
        aria-label=${labelled ? this.label : nothing}
      >
        ${href === '' ? nothing : svg`<use href=${href}></use>`}
      </svg>
    `;
  }

  private _href(): string {
    const url = getIconSpriteUrl();

    if (url === '' || !isMndwIconName(this.name)) {
      return '';
    }

    return `${url}#mndw-icon-${this.name}`;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-icon': MndwIcon;
  }
}
