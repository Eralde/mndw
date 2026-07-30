import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import {hostTypography} from '../styles/base.js';
import {MNDW_TAB_PANEL_TAG, type MndwTabPanel} from './tab-panel.js';
import {MNDW_TAB_TAG, type MndwTab} from './tab.js';

export const MNDW_TABS_TAG = 'mndw-tabs';

export interface MndwTabsChangeDetail {
  value: string;
}

/** Attributes the group writes onto its tabs, and therefore the only ones it may remove. */
const OWNED_TAB_ATTRIBUTES = ['role', 'aria-selected', 'aria-controls', 'aria-disabled', 'tabindex', 'slot'];

/** Attributes the group writes onto its panels. `hidden` is owned too — the group drives visibility. */
const OWNED_PANEL_ATTRIBUTES = ['role', 'aria-labelledby', 'hidden'];

/** Relationship inputs the group cannot see as property changes. */
const OBSERVED_ATTRIBUTES = ['id', 'for', 'disabled'];

const FORWARD_KEYS = ['ArrowRight', 'ArrowDown'];
const BACKWARD_KEYS = ['ArrowLeft', 'ArrowUp'];
const ACTIVATION_KEYS = [' ', 'Enter'];

interface Pairing {
  tabs: MndwTab[];
  panels: MndwTabPanel[];
  panelOf: Map<MndwTab, MndwTabPanel>;
}

/**
 * Container for a tab set. It carries no role of its own — making it the `tablist` would wrongly
 * include the panels — and instead owns an internal tablist, the active `value`, the APG keyboard
 * matrix, and every relationship attribute on its children.
 */
export class MndwTabs extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    // State, not configuration, so it does not reflect.
    value: {type: String},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: block;
    }

    [part='tablist'] {
      display: flex;
      gap: var(--mndw-space-1);
      border-bottom: var(--mndw-border-w) solid var(--mndw-border);
    }
  `;

  declare public value: string;

  private readonly observer: MutationObserver;
  private ownedTabs: MndwTab[] = [];
  private ownedPanels: MndwTabPanel[] = [];
  private readonly warnedPanels = new WeakSet<MndwTabPanel>();
  private readonly warnedTabs = new WeakSet<MndwTab>();

  constructor() {
    super();
    this.value = '';
    this.observer = new MutationObserver(this.onMutations);
    this.addEventListener('click', this.onClick);
    this.addEventListener('keydown', this.onKeyDown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.observer.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.observer.disconnect();
    this.release(this.ownedTabs, this.ownedPanels);
    this.ownedTabs = [];
    this.ownedPanels = [];
  }

  protected override render(): TemplateResult {
    return html`
      <div part="tablist" role="tablist" aria-orientation="horizontal">
        <slot name="tab"></slot>
      </div>
      <slot></slot>
    `;
  }

  /**
   * `value` names the active tab, so an unmatched or disabled one resolves to whatever is really
   * selected rather than leaving the property lying about itself. Normalising here rather than in
   * `updated` keeps the write inside the current update instead of scheduling another.
   */
  protected override willUpdate(): void {
    if (!this.isConnected) {
      return;
    }

    const active = this.resolveActive(this.tabChildren());

    if (this.value !== (active?.id ?? '')) {
      this.value = active?.id ?? '';
    }
  }

  protected override updated(): void {
    // An update queued before disconnection still runs after it, and writing relationships from
    // there would undo the release below.
    if (!this.isConnected) {
      return;
    }

    const pairing = this.pairing();
    const active = this.resolveActive(pairing.tabs);

    this.release(
      this.ownedTabs.filter((tab) => !pairing.tabs.includes(tab)),
      this.ownedPanels.filter((panel) => !pairing.panels.includes(panel)),
    );
    this.syncTabs(pairing, active);
    this.syncPanels(pairing, active);
    this.ownedTabs = pairing.tabs;
    this.ownedPanels = pairing.panels;
  }

  private tabChildren(): MndwTab[] {
    return [...this.children].filter((child): child is MndwTab => child.localName === MNDW_TAB_TAG);
  }

  private pairing(): Pairing {
    const tabs = this.tabChildren();
    const panels = [...this.children].filter((child): child is MndwTabPanel => child.localName === MNDW_TAB_PANEL_TAG);
    const panelOf = new Map<MndwTab, MndwTabPanel>();
    const claimed = new Set<MndwTabPanel>();

    for (const tab of tabs) {
      if (tab.id === '') {
        continue;
      }

      const panel = panels.find((candidate) => candidate.for === tab.id && !claimed.has(candidate));

      if (panel) {
        claimed.add(panel);
        panelOf.set(tab, panel);
      }
    }

    return {tabs, panels, panelOf};
  }

  /** A tab with no `id` cannot be referenced or selected, so it is inert rather than invisible. */
  private isSelectable(tab: MndwTab): boolean {
    return tab.id !== '' && !tab.disabled;
  }

  private resolveActive(tabs: MndwTab[]): MndwTab | null {
    const named = tabs.find((tab) => tab.id === this.value && this.isSelectable(tab));

    return named ?? tabs.find((tab) => this.isSelectable(tab)) ?? null;
  }

  private syncTabs(pairing: Pairing, active: MndwTab | null): void {
    for (const tab of pairing.tabs) {
      const panel = pairing.panelOf.get(tab);
      const selectable = this.isSelectable(tab);

      tab.setAttribute('slot', 'tab');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(tab === active));
      tab.setAttribute('aria-disabled', String(!selectable));
      tab.setAttribute('tabindex', tab === active ? '0' : '-1');

      if (panel) {
        tab.setAttribute('aria-controls', panel.id);
      } else {
        tab.removeAttribute('aria-controls');
      }

      if (tab.id === '' && !this.warnedTabs.has(tab)) {
        this.warnedTabs.add(tab);
        console.warn(`<${MNDW_TAB_TAG}> needs an id for its panel to reference; this one is inert.`);
      }
    }
  }

  private syncPanels(pairing: Pairing, active: MndwTab | null): void {
    const tabOf = new Map<MndwTabPanel, MndwTab>();

    for (const [tab, panel] of pairing.panelOf) {
      tabOf.set(panel, tab);
    }

    for (const panel of pairing.panels) {
      const tab = tabOf.get(panel);

      panel.setAttribute('role', 'tabpanel');
      panel.hidden = tab !== active;

      if (tab) {
        panel.setAttribute('aria-labelledby', tab.id);

        continue;
      }

      panel.removeAttribute('aria-labelledby');

      if (!this.warnedPanels.has(panel)) {
        this.warnedPanels.add(panel);
        console.warn(`<${MNDW_TAB_PANEL_TAG} for="${panel.for}"> matches no <${MNDW_TAB_TAG}> id; it stays hidden.`);
      }
    }
  }

  private release(tabs: readonly MndwTab[], panels: readonly MndwTabPanel[]): void {
    for (const tab of tabs) {
      for (const attribute of OWNED_TAB_ATTRIBUTES) {
        tab.removeAttribute(attribute);
      }
    }

    for (const panel of panels) {
      for (const attribute of OWNED_PANEL_ATTRIBUTES) {
        panel.removeAttribute(attribute);
      }
    }
  }

  // No `slotchange` listener: the group reads its light-DOM children directly, so `childList` is
  // the real signal — and listening for slot changes would loop, since assigning `slot="tab"` is
  // itself a slot change.
  private readonly onMutations = (): void => {
    this.requestUpdate();
  };

  private readonly onClick = (event: Event): void => {
    const tab = this.tabFrom(event.target);

    if (!tab || !this.isSelectable(tab)) {
      return;
    }

    this.activate(tab);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const focusable = [...this.children]
      .filter((child): child is MndwTab => child.localName === MNDW_TAB_TAG)
      .filter((tab) => this.isSelectable(tab));

    if (focusable.length === 0) {
      return;
    }

    const next = this.nextTab(event.key, focusable, this.tabFrom(event.target));

    if (!next) {
      return;
    }

    event.preventDefault();
    this.activate(next);
  };

  private nextTab(key: string, focusable: MndwTab[], from: MndwTab | null): MndwTab | null {
    const current = from ? focusable.indexOf(from) : -1;
    const last = focusable.length - 1;

    if (FORWARD_KEYS.includes(key)) {
      return focusable[current < 0 || current === last ? 0 : current + 1];
    }

    if (BACKWARD_KEYS.includes(key)) {
      return focusable[current <= 0 ? last : current - 1];
    }

    if (key === 'Home') {
      return focusable[0];
    }

    if (key === 'End') {
      return focusable[last];
    }

    if (ACTIVATION_KEYS.includes(key) && current >= 0) {
      return focusable[current];
    }

    return null;
  }

  private tabFrom(target: EventTarget | null): MndwTab | null {
    const tab = target instanceof Element ? target.closest<MndwTab>(MNDW_TAB_TAG) : null;

    return tab?.parentElement === this ? tab : null;
  }

  /** Automatic activation: moving the focus moves the selection, per the APG tabs pattern. */
  private activate(tab: MndwTab): void {
    const changed = this.value !== tab.id;

    this.value = tab.id;
    tab.focus();

    if (changed) {
      this.dispatchEvent(
        new CustomEvent<MndwTabsChangeDetail>('mndwchange', {
          bubbles: true,
          composed: true,
          detail: {value: this.value},
        }),
      );
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-tabs': MndwTabs;
  }
}
