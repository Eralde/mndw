import {afterEach, describe, expect, it, vi} from 'vitest';
import {defineComponents, mount as mountComponent, settle} from '../testing/index.js';
import {MNDW_TAB_PANEL_TAG, MndwTabPanel} from './tab-panel.js';
import {MNDW_TAB_TAG, MndwTab} from './tab.js';
import {MNDW_TABS_TAG, MndwTabs} from './tabs.js';

defineComponents(
  [MNDW_TABS_TAG, MndwTabs],
  [MNDW_TAB_TAG, MndwTab],
  [MNDW_TAB_PANEL_TAG, MndwTabPanel],
);

afterEach(() => {
  vi.restoreAllMocks();
});

const THREE_TABS = `
  <mndw-tabs>
    <mndw-tab id="general">General</mndw-tab>
    <mndw-tab id="network">Network</mndw-tab>
    <mndw-tab id="advanced" disabled>Advanced</mndw-tab>
    <mndw-tab-panel for="general">General body</mndw-tab-panel>
    <mndw-tab-panel for="network">Network body</mndw-tab-panel>
    <mndw-tab-panel for="advanced">Advanced body</mndw-tab-panel>
  </mndw-tabs>
`;

async function mount(html: string): Promise<MndwTabs> {
  const element = await mountComponent(html, MNDW_TABS_TAG);

  // Two turns: a reflected child property reaches the group through Lit, the observer, and a second group update.
  await settle(element, 2);

  return element;
}

function tabOf(element: MndwTabs, id: string): MndwTab {
  const tab = element.querySelector<MndwTab>(`${MNDW_TAB_TAG}#${id}`);

  if (!tab) {
    throw new Error(`missing tab ${id}`);
  }

  return tab;
}

function panelFor(element: MndwTabs, id: string): MndwTabPanel {
  const panel = element.querySelector<MndwTabPanel>(`${MNDW_TAB_PANEL_TAG}[for="${id}"]`);

  if (!panel) {
    throw new Error(`missing panel for ${id}`);
  }

  return panel;
}

async function press(element: MndwTabs, key: string, from: Element): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {key, bubbles: true, composed: true, cancelable: true});

  from.dispatchEvent(event);
  await settle(element, 2);

  return event;
}

describe('<mndw-tabs> structure', () => {
  it('is a container, not a widget', async () => {
    const element = await mount(THREE_TABS);

    expect(element.hasAttribute('role')).toBe(false);
  });

  it('puts the tablist role on an internal wrapper it exposes as a part', async () => {
    const element = await mount(THREE_TABS);
    const tablist = element.shadowRoot?.querySelector('[part="tablist"]');

    expect(tablist?.getAttribute('role')).toBe('tablist');
    expect(tablist?.getAttribute('aria-orientation')).toBe('horizontal');
    expect(tablist?.querySelector('slot')).not.toBeNull();
  });

  it('selects the first enabled tab when no value is authored', async () => {
    const element = await mount(THREE_TABS);

    expect(element.value).toBe('general');
    expect(tabOf(element, 'general').getAttribute('aria-selected')).toBe('true');
    expect(tabOf(element, 'network').getAttribute('aria-selected')).toBe('false');
  });

  it('honours an authored value', async () => {
    const element = await mount(THREE_TABS.replace('<mndw-tabs>', '<mndw-tabs value="network">'));

    expect(element.value).toBe('network');
    expect(tabOf(element, 'network').getAttribute('aria-selected')).toBe('true');
  });

  it('falls back to the first enabled tab for an unmatched value', async () => {
    const element = await mount(THREE_TABS.replace('<mndw-tabs>', '<mndw-tabs value="nope">'));

    expect(element.value).toBe('general');
  });

  it('never resolves to a disabled tab', async () => {
    const element = await mount(THREE_TABS.replace('<mndw-tabs>', '<mndw-tabs value="advanced">'));

    expect(element.value).toBe('general');
  });

  it('writes tab semantics and the roving tab stop', async () => {
    const element = await mount(THREE_TABS);
    const general = tabOf(element, 'general');
    const network = tabOf(element, 'network');
    const advanced = tabOf(element, 'advanced');

    expect(general.getAttribute('role')).toBe('tab');
    expect(general.getAttribute('tabindex')).toBe('0');
    expect(network.getAttribute('tabindex')).toBe('-1');
    expect(advanced.getAttribute('aria-disabled')).toBe('true');
    expect(network.getAttribute('aria-disabled')).toBe('false');
  });

  it('assigns tabs to the tablist slot and leaves panels in the default slot', async () => {
    const element = await mount(THREE_TABS);

    expect(tabOf(element, 'general').getAttribute('slot')).toBe('tab');
    expect(panelFor(element, 'general').hasAttribute('slot')).toBe(false);
  });
});

describe('<mndw-tabs> relationships', () => {
  it('wires reciprocal aria-controls and aria-labelledby', async () => {
    const element = await mount(THREE_TABS);
    const tab = tabOf(element, 'general');
    const panel = panelFor(element, 'general');

    expect(panel.id).not.toBe('');
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('general');
  });

  it('hides every panel but the active one', async () => {
    const element = await mount(THREE_TABS);

    expect(panelFor(element, 'general').hidden).toBe(false);
    expect(panelFor(element, 'network').hidden).toBe(true);
    expect(panelFor(element, 'advanced').hidden).toBe(true);
  });

  it('rewires when a tab id changes', async () => {
    const element = await mount(THREE_TABS);
    const tab = tabOf(element, 'network');

    tab.id = 'renamed';
    await settle(element, 2);

    expect(tab.hasAttribute('aria-controls')).toBe(false);
    expect(panelFor(element, 'network').hidden).toBe(true);
    expect(panelFor(element, 'network').hasAttribute('aria-labelledby')).toBe(false);
  });

  it('rewires when a panel for changes', async () => {
    const element = await mount(`
      <mndw-tabs>
        <mndw-tab id="general">General</mndw-tab>
        <mndw-tab id="network">Network</mndw-tab>
        <mndw-tab-panel id="first" for="general">General body</mndw-tab-panel>
        <mndw-tab-panel id="second" for="ghost">Unpaired body</mndw-tab-panel>
      </mndw-tabs>
    `);
    const second = element.querySelector<MndwTabPanel>('#second');

    if (!second) {
      throw new Error('missing second panel');
    }

    expect(second.hasAttribute('aria-labelledby')).toBe(false);

    second.for = 'network';
    await settle(element, 2);

    expect(second.getAttribute('aria-labelledby')).toBe('network');
    expect(tabOf(element, 'network').getAttribute('aria-controls')).toBe('second');
  });

  it('follows child order when two panels claim one tab', async () => {
    const element = await mount(`
      <mndw-tabs>
        <mndw-tab id="general">General</mndw-tab>
        <mndw-tab-panel id="first" for="general">First</mndw-tab-panel>
        <mndw-tab-panel id="second" for="general">Second</mndw-tab-panel>
      </mndw-tabs>
    `);
    const first = element.querySelector<MndwTabPanel>('#first');
    const second = element.querySelector<MndwTabPanel>('#second');

    if (!first || !second) {
      throw new Error('missing panels');
    }

    expect(tabOf(element, 'general').getAttribute('aria-controls')).toBe('first');
    expect(second.hasAttribute('aria-labelledby')).toBe(false);

    element.insertBefore(second, first);
    await settle(element, 2);

    expect(tabOf(element, 'general').getAttribute('aria-controls')).toBe('second');
    expect(second.getAttribute('aria-labelledby')).toBe('general');
    expect(first.hasAttribute('aria-labelledby')).toBe(false);
    expect(first.hidden).toBe(true);
  });

  it('follows child order for keyboard navigation', async () => {
    const element = await mount(THREE_TABS);
    const general = tabOf(element, 'general');
    const network = tabOf(element, 'network');

    element.insertBefore(network, general);
    await settle(element, 2);

    // `general` is still a valid selection, so reordering moves the order, not the selection.
    expect(element.value).toBe('general');
    expect(general.getAttribute('tabindex')).toBe('0');

    await press(element, 'ArrowLeft', general);

    expect(element.value).toBe('network');
  });

  it('releases only the attributes it owns when a child leaves', async () => {
    const element = await mount(THREE_TABS);
    const tab = tabOf(element, 'network');
    const panel = panelFor(element, 'network');

    tab.remove();
    panel.remove();
    await settle(element, 2);

    for (const attribute of ['role', 'aria-selected', 'aria-controls', 'aria-disabled', 'tabindex', 'slot']) {
      expect(tab.hasAttribute(attribute)).toBe(false);
    }

    expect(panel.hasAttribute('role')).toBe(false);
    expect(panel.hasAttribute('aria-labelledby')).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(tab.id).toBe('network');
    expect(panel.getAttribute('for')).toBe('network');
  });

  it('releases its children on disconnect', async () => {
    const element = await mount(THREE_TABS);
    const tab = tabOf(element, 'general');

    element.remove();
    await settle(element, 2);

    expect(tab.hasAttribute('role')).toBe(false);
    expect(tab.hasAttribute('tabindex')).toBe(false);
  });

  it('warns once about a panel whose tab does not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const element = await mount(`
      <mndw-tabs>
        <mndw-tab id="general">General</mndw-tab>
        <mndw-tab-panel for="general">General body</mndw-tab-panel>
        <mndw-tab-panel for="ghost">Orphan</mndw-tab-panel>
      </mndw-tabs>
    `);
    const orphan = panelFor(element, 'ghost');

    expect(orphan.hidden).toBe(true);
    expect(orphan.hasAttribute('aria-labelledby')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ghost');

    element.value = 'general';
    await settle(element, 2);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once about a tab with no id and keeps it inert', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const element = await mount(`
      <mndw-tabs>
        <mndw-tab>Nameless</mndw-tab>
        <mndw-tab id="general">General</mndw-tab>
        <mndw-tab-panel for="general">General body</mndw-tab-panel>
      </mndw-tabs>
    `);
    const nameless = element.querySelector<MndwTab>('mndw-tab:not([id])');

    expect(element.value).toBe('general');
    expect(nameless?.getAttribute('role')).toBe('tab');
    expect(nameless?.getAttribute('aria-disabled')).toBe('true');
    expect(nameless?.getAttribute('tabindex')).toBe('-1');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('<mndw-tabs> activation', () => {
  it('activates a clicked tab and reports the new value', async () => {
    const element = await mount(THREE_TABS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    tabOf(element, 'network').click();
    await settle(element, 2);

    expect(element.value).toBe('network');
    expect(panelFor(element, 'network').hidden).toBe(false);
    expect(panelFor(element, 'general').hidden).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect((changes.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'network'});
  });

  it('ignores a click on a disabled tab', async () => {
    const element = await mount(THREE_TABS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    tabOf(element, 'advanced').click();
    await settle(element, 2);

    expect(element.value).toBe('general');
    expect(changes).not.toHaveBeenCalled();
  });

  it('emits nothing when the active tab is clicked again', async () => {
    const element = await mount(THREE_TABS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    tabOf(element, 'general').click();
    await settle(element, 2);

    expect(changes).not.toHaveBeenCalled();
  });

  it('emits nothing for a programmatic value change', async () => {
    const element = await mount(THREE_TABS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    element.value = 'network';
    await settle(element, 2);

    expect(panelFor(element, 'network').hidden).toBe(false);
    expect(changes).not.toHaveBeenCalled();
  });

  it('moves focus and selection together, skipping disabled tabs', async () => {
    const element = await mount(THREE_TABS);
    const forward = await press(element, 'ArrowRight', tabOf(element, 'general'));

    expect(element.value).toBe('network');
    expect(forward.defaultPrevented).toBe(true);

    // `advanced` is disabled, so forward from the last enabled tab wraps to the first.
    await press(element, 'ArrowRight', tabOf(element, 'network'));

    expect(element.value).toBe('general');

    await press(element, 'ArrowLeft', tabOf(element, 'general'));

    expect(element.value).toBe('network');
  });

  it('jumps to the first and last enabled tab with Home and End', async () => {
    const element = await mount(THREE_TABS);

    await press(element, 'End', tabOf(element, 'general'));

    expect(element.value).toBe('network');

    await press(element, 'Home', tabOf(element, 'network'));

    expect(element.value).toBe('general');
  });

  it('ignores keys outside the tabs matrix', async () => {
    const element = await mount(THREE_TABS);
    const other = await press(element, 'a', tabOf(element, 'general'));

    expect(element.value).toBe('general');
    expect(other.defaultPrevented).toBe(false);
  });

  it('reports one change per keystroke that moves the selection', async () => {
    const element = await mount(THREE_TABS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    await press(element, 'ArrowRight', tabOf(element, 'general'));
    await press(element, 'Home', tabOf(element, 'network'));

    expect(changes).toHaveBeenCalledTimes(2);
    expect((changes.mock.calls[1][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'general'});
  });
});
