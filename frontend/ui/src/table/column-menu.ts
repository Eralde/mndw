import {LitElement, type PropertyDeclarations, css, html} from 'lit';
import {focusRing, hostTypography} from '../styles/base.js';

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
      background: var(--mndw-surface-hover);
    }

    [part='option']:focus-visible {
      ${focusRing}
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
      this.columns.map((column) =>
        html`
          <button
            type="button"
            part="option"
            role="menuitemcheckbox"
            tabindex="-1"
            data-column-id=${column.id}
            aria-checked=${String(!this.workingHidden.has(column.id))}
            @click=${() => this.toggle(column.id)}
          >${column.label}</button>
        `
      )
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
