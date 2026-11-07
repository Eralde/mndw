import {LitElement, type PropertyDeclarations, css, html} from 'lit';
import {AriaKeyManager, type KeyManagerList} from '../aria/key-manager.js';
import {deepActiveElement} from '../focus.js';
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
  defer?: boolean;
  tabDirection?: 'backward' | 'forward';
}

export type MndwColumnMenuInitialFocus = 'first' | 'last';

export class MndwColumnMenu extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    columns: {type: Array, attribute: false},
    hiddenColumns: {type: Array, attribute: false},
    initialFocus: {type: String, attribute: false},
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
  declare public initialFocus: MndwColumnMenuInitialFocus;

  private workingHidden = new Set<string>();
  private readonly keyManager = new AriaKeyManager<MndwColumnMenuOption>({
    getLabel: (column) => column.label,
    isDisabled: () => false,
  });

  constructor() {
    super();
    this.columns = [];
    this.hiddenColumns = [];
    this.initialFocus = 'first';
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.workingHidden = new Set(this.hiddenColumns);
  }

  protected override firstUpdated(): void {
    this.focusInitialOption();
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

  public focusInitialOption(): void {
    this.focusOption(this.initialFocus === 'last' ? this.columns.length - 1 : 0);
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
    const focused = deepActiveElement();
    let activeIndex = buttons.indexOf(focused as HTMLButtonElement);

    if (activeIndex < 0) {
      activeIndex = 0;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      buttons[activeIndex]?.click();
      this.dismiss(true);

      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.dismiss(true);

      return;
    }

    if (event.key === 'Tab') {
      this.dismiss(false, true, event.shiftKey ? 'backward' : 'forward');

      return;
    }

    const list: KeyManagerList<MndwColumnMenuOption> = {
      items: this.columns,
      wrap: true,
      mode: 'roving-focus',
      get activeIndex(): number {
        return activeIndex;
      },
      set activeIndex(index: number) {
        activeIndex = index;
      },
      setActiveIndex(index: number): void {
        activeIndex = index;
      },
      focusItem(index: number): void {
        buttons[index]?.focus();
      },
    };

    this.keyManager.handleKeydown(event, list);
  };

  private dismiss(
    restoreFocus: boolean,
    defer = false,
    tabDirection?: 'backward' | 'forward',
  ): void {
    const detail: MndwPanelDismissDetail = defer && tabDirection !== undefined
      ? {restoreFocus, defer: true, tabDirection}
      : defer
      ? {restoreFocus, defer: true}
      : {restoreFocus};

    this.dispatchEvent(
      new CustomEvent<MndwPanelDismissDetail>('mndwpaneldismiss', {
        bubbles: true,
        composed: true,
        detail,
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
