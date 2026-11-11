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

  it('keeps the first option active without selecting an option when value is empty', async () => {
    const panel = await mount();
    const rendered = items(panel);

    expect(rendered.map((item) => item.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);
    expect(rendered.map((item) => item.getAttribute('data-active'))).toEqual(['true', 'false', 'false']);
    expect(rendered.map((item) => item.querySelector('mndw-icon'))).toEqual([null, null, null]);
    expect(panel.listboxElement?.getAttribute('aria-activedescendant')).toBe(rendered[0].id);
  });

  it('keeps selection on the value while active option moves', async () => {
    const panel = await mount('wifi');
    const rendered = items(panel);

    expect(rendered.map((item) => item.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(rendered.map((item) => item.getAttribute('data-active'))).toEqual(['false', 'true', 'false']);

    panel.activeIndex = 0;
    await panel.updateComplete;

    expect(items(panel).map((item) => item.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(items(panel).map((item) => item.getAttribute('data-active'))).toEqual(['true', 'false', 'false']);
    expect(items(panel).map((item) => item.querySelector('mndw-icon')?.getAttribute('name') ?? null)).toEqual([
      null,
      'check',
      null,
    ]);
    expect(panel.listboxElement?.getAttribute('aria-activedescendant')).toBe(items(panel)[0].id);
  });

  it('selects an empty-valued option when it matches the empty value', async () => {
    const panel = await mount();

    panel.options = [
      {value: '', label: 'Always on', labelNodes: [], disabled: false},
      {value: 'hourly', label: 'Hourly', labelNodes: [], disabled: false},
    ];
    await panel.updateComplete;

    expect(items(panel).map((item) => item.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(items(panel)[0].querySelector('mndw-icon')?.getAttribute('name')).toBe('check');
    expect(items(panel)[1].querySelector('mndw-icon')).toBeNull();
  });

  it('keeps only the first matching value selected when duplicate values exist', async () => {
    const panel = await mount('eth0');

    panel.options = [
      {value: 'eth0', label: 'LAN', labelNodes: [], disabled: false},
      {value: 'eth0', label: 'LAN (bridged)', labelNodes: [], disabled: false},
    ];
    await panel.updateComplete;
    panel.activeIndex = 1;
    await panel.updateComplete;

    expect(items(panel).map((item) => item.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(items(panel).filter((item) => item.querySelector('mndw-icon'))).toHaveLength(1);
  });

  it('styles the active option with the hover surface', () => {
    const styles = String(MndwSelectPanel.styles);

    expect(styles).toMatch(/\.option\[data-active='true'\]:not\(\[aria-disabled='true'\]\)/);
    expect(styles).toContain('var(--mndw-surface-hover)');
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

  it('does not put popup options in the tab order', async () => {
    const rendered = items(await mount('wifi'));

    expect(rendered.map((item) => item.hasAttribute('tabindex'))).toEqual([false, false, false]);
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
