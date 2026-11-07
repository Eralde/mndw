import {LitElement, type PropertyDeclarations, css, html} from 'lit';
import {focusRing, hostTypography, surfaceHover} from '../styles/base.js';

export const MNDW_COLUMN_MENU_TAG = 'mndw-column-menu';
export const MNDW_COLUMN_MENU_CHECK_EVENT = 'mndwcolumnmenucheck';

export interface MndwColumnMenuOption {
  id: string;
  label: string;
}

export interface MndwColumnMenuCheckDetail {
  hidden: string[];
}

export interface MndwPanelDismissDetail {
  restoreFocus: boolean;
}

export class MndwColumnMenu extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    columns: {type: Array, attribute: false},
    hiddenColumns: {type: Array, attribute: false},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}
      display: block;
      color: var(--mndw-text);
    }

    [part='menu'] {
      display: flex;
      flex-direction: column;
      min-width: 11.25rem;
      padding: var(--mndw-space-2);
      gap: var(--mndw-space-1);
      background: var(--mndw-surface-raised);
      border: 1px solid var(--mndw-border);
      border-radius: var(--mndw-radius-md);
      box-shadow: var(--mndw-shadow-2);
    }

    [part='option'] {
      display: flex;
      align-items: center;
      gap: var(--mndw-space-2);
      padding: var(--mndw-space-2);
      border: 0;
      border-radius: var(--mndw-radius-sm);
      background: none;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }

    [part='option']:hover {
      ${surfaceHover}
    }

    [part='option']:focus-visible {
      ${focusRing}
    }

    [part='indicator'] {
      display: inline-grid;
      width: 1.125rem;
      height: 1.125rem;
      place-items: center;
      border: 1px solid var(--mndw-border);
      border-radius: var(--mndw-radius-sm);
      background: var(--mndw-surface);
      color: var(--mndw-accent-contrast);
      flex: 0 0 auto;
    }

    [part='indicator'][data-checked='true'] {
      border-color: var(--mndw-accent);
      background: var(--mndw-accent);
    }

    [part='checkmark'] {
      width: 0.3rem;
      height: 0.55rem;
      border: solid currentColor;
      border-width: 0 2px 2px 0;
      transform: translateY(-0.0625rem) rotate(45deg);
    }
  `;

  declare public columns: MndwColumnMenuOption[];
  declare public hiddenColumns: string[];

  private workingHidden = new Set<string>();

  constructor() {
    super();
    this.columns = [];
    this.hiddenColumns = [];
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.workingHidden = new Set(this.hiddenColumns);
  }

  protected override firstUpdated(): void {
    this.focusOption(0);
  }

  protected override render(): unknown {
    return html`
      <div
        part="menu"
        role="menu"
        @keydown=${this.handleKeydown}
      >
        ${
      this.columns.map((column) => {
        const checked = !this.workingHidden.has(column.id);

        return html`
          <button
            type="button"
            part="option"
            role="menuitemcheckbox"
            tabindex="-1"
            data-column-id=${column.id}
            aria-checked=${String(checked)}
            @click=${() => this.toggle(column.id)}
          >
            <span part="indicator" data-checked=${String(checked)} aria-hidden="true">
              ${checked ? html`<span part="checkmark"></span>` : null}
            </span>
            ${column.label}
          </button>
        `;
      })
    }
      </div>
    `;
  }

  private toggle(id: string): void {
    if (this.workingHidden.has(id)) {
      this.workingHidden.delete(id);
    } else {
      this.workingHidden.add(id);
    }

    this.requestUpdate();
    this.dispatchEvent(
      new CustomEvent<MndwColumnMenuCheckDetail>(MNDW_COLUMN_MENU_CHECK_EVENT, {
        bubbles: true,
        composed: true,
        detail: {hidden: [...this.workingHidden]},
      }),
    );
  }

  public focusFirstOption(): void {
    this.focusOption(0);
  }

  private focusOption(index: number): void {
    const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('button[data-column-id]')];

    if (buttons.length === 0) {
      return;
    }

    buttons[((index % buttons.length) + buttons.length) % buttons.length]?.focus();
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('button[data-column-id]')];
    const currentIndex = buttons.indexOf(event.target as HTMLButtonElement);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusOption(currentIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.focusOption(currentIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        this.focusOption(0);
        break;
      case 'End':
        event.preventDefault();
        this.focusOption(buttons.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.dismiss(true);
        break;
      case 'Tab':
        event.preventDefault();
        this.dismiss(false);
        break;
      default:
        break;
    }
  };

  private dismiss(restoreFocus: boolean): void {
    this.dispatchEvent(
      new CustomEvent<MndwPanelDismissDetail>('mndwpaneldismiss', {
        bubbles: true,
        composed: true,
        detail: {restoreFocus},
      }),
    );
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-column-menu': MndwColumnMenu;
  }
}
