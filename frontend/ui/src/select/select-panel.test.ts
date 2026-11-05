// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import {MNDW_SCROLL_AREA_TAG, MndwScrollArea} from '../scroll-area/scroll-area.js';
import {defineComponents} from '../testing/index.js';
import {MNDW_SELECT_PANEL_TAG, MndwSelectPanel} from './select-panel.js';
import {MNDW_ICON_TAG, MndwIcon} from '../icon/icon.js';
import type {OptionModel} from './option-model.js';

defineComponents(
  [MNDW_SCROLL_AREA_TAG, MndwScrollArea],
  [MNDW_SELECT_PANEL_TAG, MndwSelectPanel],
  [MNDW_ICON_TAG, MndwIcon],
);

const options: OptionModel[] = [
  {value: 'isp', label: 'Wired', labelNodes: [], disabled: false},
  {value: 'wifi', label: 'Wireless', labelNodes: [], disabled: false},
  {value: 'vpn', label: 'VPN', labelNodes: [], disabled: true},
];

async function mount(value = ''): Promise<MndwSelectPanel> {
  document.body.innerHTML = '';

  const panel = document.createElement(MNDW_SELECT_PANEL_TAG);

  panel.options = options;
  panel.value = value;
  panel.label = 'Interface';
  document.body.appendChild(panel);
  await panel.updateComplete;

  return panel;
}

function items(panel: MndwSelectPanel): HTMLElement[] {
  return Array.from(panel.shadowRoot?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
}

async function press(panel: MndwSelectPanel, key: string): Promise<void> {
  const listbox = panel.shadowRoot?.querySelector('[role="listbox"]');

  listbox?.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true}));
  await panel.updateComplete;
}

describe('<mndw-select-panel>', () => {
  it('renders rich label nodes without HTML string interpolation', async () => {
    const panel = await mount();
    const strong = document.createElement('strong');

    strong.textContent = 'Wired';
    panel.options = [{
      value: 'isp',
      label: 'Wired 5GHz',
      labelNodes: [strong, document.createTextNode(' 5GHz')],
      disabled: false,
    }];
    await panel.updateComplete;

    expect(panel.shadowRoot?.querySelector('[role="option"] strong')).not.toBeNull();
    expect(panel.shadowRoot?.querySelector('[role="option"]')?.textContent).toContain('5GHz');
  });

  it('renders one role=option per model entry', async () => {
    expect(items(await mount())).toHaveLength(3);
  });

  it('reflects sheet layout mode on the panel host', async () => {
    const panel = await mount();

    panel.sheet = true;
    await panel.updateComplete;

    expect(panel.hasAttribute('sheet')).toBe(true);
    expect(panel.shadowRoot?.querySelector('[part="listbox"]')).not.toBeNull();
    expect(panel.shadowRoot?.querySelector(MNDW_SCROLL_AREA_TAG)).not.toBeNull();
  });

  it('keeps sheet panel content-sized and stays a flex column', () => {
    const styles = String(MndwSelectPanel.styles);

    expect(styles).not.toContain('--mndw-select-sheet-max-height');
    expect(styles).not.toContain('54px');
    expect(styles).toMatch(/:host\(\[sheet\]\)\s*\{/);
    expect(styles).not.toMatch(/:host\(\[sheet\]\)\s*\{[^}]*display:\s*block/);
    expect(styles).not.toMatch(/:host\(\[sheet\]\)\s*\{[^}]*height:\s*auto/);
  });

  it('owns the outer border on the panel host', () => {
    const styles = String(MndwSelectPanel.styles);

    expect(styles).toMatch(/:host\s*\{[^}]*\swidth:\s*100%;/);
    expect(styles).toMatch(/:host\s*\{[^}]*border:\s*var\(--mndw-border-w\) solid var\(--mndw-border\);/);
    expect(styles).not.toMatch(/\.listbox\s*\{[^}]*border:\s*1px solid var\(--mndw-border\);/);
  });

  it('wraps listbox in scroll area and keeps chrome on the host', async () => {
    const panel = await mount();
    const styles = String(MndwSelectPanel.styles);
    const scrollArea = panel.shadowRoot?.querySelector(MNDW_SCROLL_AREA_TAG);

    expect(panel.shadowRoot?.querySelector('mndw-scroll-area [role="listbox"]')).not.toBeNull();
    expect(styles).toMatch(/:host\s*\{[^}]*border:\s*var\(--mndw-border-w\) solid var\(--mndw-border\);/);
    expect(styles).toMatch(/:host\s*\{[^}]*border-radius:\s*var\(--mndw-radius-md\);/);
    expect(styles).toContain('overflow: hidden;');
    expect(styles).toContain('padding-inline-end:');
    expect(styles).not.toMatch(/(?:^|\n)[ \t]*\.listbox[ \t]*\{[^}]*border:/);
    expect(styles).not.toMatch(/(?:^|\n)[ \t]*\.listbox[ \t]*\{[^}]*border-radius:/);
    expect(styles).not.toMatch(/(?:^|\n)[ \t]*\.listbox[ \t]*\{[^}]*background:/);
    expect(styles).not.toMatch(/(?:^|\n)[ \t]*\.listbox[ \t]*\{[^}]*box-shadow:/);
    expect(styles).not.toMatch(/(?:^|\n)[ \t]*\.listbox[ \t]*\{[^}]*overflow/);
    expect(scrollArea?.getAttribute('exportparts')).toBe('viewport,scrollbar,track,thumb');
  });

  it('names the listbox from the label', async () => {
    const panel = await mount();

    expect(panel.shadowRoot?.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe(
      'Interface',
    );
  });

  it('marks the selected option', async () => {
    const rendered = items(await mount('wifi'));

    expect(rendered[0].getAttribute('aria-selected')).toBe('false');
    expect(rendered[1].getAttribute('aria-selected')).toBe('true');
  });

  it('renders a shared check icon only on the selected option', async () => {
    const rendered = items(await mount('wifi'));

    expect(rendered[0].querySelector('mndw-icon')).toBeNull();
    expect(rendered[1].querySelector('mndw-icon')?.getAttribute('name')).toBe('check');
  });

  it('starts active on the selected option', async () => {
    expect((await mount('wifi')).activeIndex).toBe(1);
  });

  it('starts active on the first option when nothing is selected', async () => {
    expect((await mount()).activeIndex).toBe(0);
  });

  it('gives only the active option tabindex 0', async () => {
    const rendered = items(await mount('wifi'));

    expect(rendered.map((item) => item.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('moves active down on ArrowDown', async () => {
    const panel = await mount();

    await press(panel, 'ArrowDown');

    expect(panel.activeIndex).toBe(1);
  });

  it('skips disabled options when moving', async () => {
    const panel = await mount('wifi');

    await press(panel, 'ArrowDown');

    expect(panel.activeIndex).toBe(0);
  });

  it('wraps from the first option on ArrowUp', async () => {
    const panel = await mount();

    await press(panel, 'ArrowUp');

    expect(panel.activeIndex).toBe(1);
  });

  it('jumps to first and last on Home and End', async () => {
    const panel = await mount('wifi');

    await press(panel, 'End');
    expect(panel.activeIndex).toBe(1);

    await press(panel, 'Home');
    expect(panel.activeIndex).toBe(0);
  });

  it('emits mndwpanelselect on Enter', async () => {
    const panel = await mount();
    const onSelect = vi.fn();

    panel.addEventListener('mndwpanelselect', onSelect);
    await press(panel, 'Enter');

    expect((onSelect.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'isp'});
  });

  it('emits mndwpanelselect on click', async () => {
    const panel = await mount();
    const onSelect = vi.fn();

    panel.addEventListener('mndwpanelselect', onSelect);
    items(panel)[1].click();

    expect((onSelect.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'wifi'});
  });

  it('does not select a disabled option on click', async () => {
    const panel = await mount();
    const onSelect = vi.fn();

    panel.addEventListener('mndwpanelselect', onSelect);
    items(panel)[2].click();

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('emits dismiss with restoreFocus on Escape', async () => {
    const panel = await mount();
    const onDismiss = vi.fn();

    panel.addEventListener('mndwpaneldismiss', onDismiss);
    await press(panel, 'Escape');

    expect((onDismiss.mock.calls[0][0] as CustomEvent<{restoreFocus: boolean}>).detail).toEqual({
      restoreFocus: true,
    });
  });

  it('stops Escape propagation after dismissing', async () => {
    const panel = await mount();
    const listbox = panel.shadowRoot?.querySelector('[role="listbox"]');
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    });

    listbox?.dispatchEvent(event);

    expect(event.cancelBubble).toBe(true);
  });

  it('emits dismiss with restoreFocus on Tab', async () => {
    const panel = await mount();
    const onDismiss = vi.fn();

    panel.addEventListener('mndwpaneldismiss', onDismiss);
    await press(panel, 'Tab');

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('prevents browser Tab navigation before dismissing', async () => {
    const panel = await mount();
    const listbox = panel.shadowRoot?.querySelector('[role="listbox"]');
    const event = new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true});

    listbox?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps internal events inside the panel', async () => {
    const panel = await mount();
    const onSelect = vi.fn();

    document.body.addEventListener('mndwpanelselect', onSelect);
    await press(panel, 'Enter');

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders every option when two share a value', async () => {
    document.body.innerHTML = '';

    const panel = document.createElement(MNDW_SELECT_PANEL_TAG);

    panel.options = [
      {value: 'eth0', label: 'LAN', labelNodes: [], disabled: false},
      {value: 'eth0', label: 'LAN (bridged)', labelNodes: [], disabled: false},
      {value: 'eth1', label: 'WAN', labelNodes: [], disabled: false},
    ];
    document.body.appendChild(panel);
    await panel.updateComplete;

    const rendered = items(panel);

    expect(rendered).toHaveLength(3);
    expect(rendered.map((item) => item.textContent?.trim())).toEqual(['LAN', 'LAN (bridged)', 'WAN']);
  });
});
