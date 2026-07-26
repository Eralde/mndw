import {beforeAll, describe, expect, it, vi} from 'vitest';
import {MNDW_SELECT_PANEL_TAG, MndwSelectPanel} from './select-panel.js';
import type {OptionModel} from './option-model.js';

beforeAll(() => {
  if (!customElements.get(MNDW_SELECT_PANEL_TAG)) {
    customElements.define(MNDW_SELECT_PANEL_TAG, MndwSelectPanel);
  }
});

const options: OptionModel[] = [
  {value: 'isp', label: 'Wired', disabled: false},
  {value: 'wifi', label: 'Wireless', disabled: false},
  {value: 'vpn', label: 'VPN', disabled: true},
];

async function mount(value = ''): Promise<MndwSelectPanel> {
  document.body.innerHTML = '';

  const panel = document.createElement(MNDW_SELECT_PANEL_TAG) as MndwSelectPanel;

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
  it('renders one role=option per model entry', async () => {
    expect(items(await mount())).toHaveLength(3);
  });

  it('reflects sheet layout mode on the panel host', async () => {
    const panel = await mount();

    panel.sheet = true;
    await panel.updateComplete;

    expect(panel.hasAttribute('sheet')).toBe(true);
    expect(panel.shadowRoot?.querySelector('[part="listbox"]')).not.toBeNull();
  });

  it('uses content sizing with a viewport cap for sheet lists', async () => {
    const panel = await mount();

    panel.sheet = true;
    await panel.updateComplete;

    const styles = String(MndwSelectPanel.styles);

    expect(styles).toContain('height: auto;');
    expect(styles).toContain('max-height: calc(100dvh - 54px);');
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

    const panel = document.createElement(MNDW_SELECT_PANEL_TAG) as MndwSelectPanel;

    panel.options = [
      {value: 'eth0', label: 'LAN', disabled: false},
      {value: 'eth0', label: 'LAN (bridged)', disabled: false},
      {value: 'eth1', label: 'WAN', disabled: false},
    ];
    document.body.appendChild(panel);
    await panel.updateComplete;

    const rendered = items(panel);

    expect(rendered).toHaveLength(3);
    expect(rendered.map((item) => item.textContent?.trim())).toEqual(['LAN', 'LAN (bridged)', 'WAN']);
  });
});
