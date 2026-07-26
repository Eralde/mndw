import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {MNDW_OPTION_TAG, MndwOption} from './option.js';
import {MNDW_SELECT_PANEL_TAG, MndwSelectPanel} from './select-panel.js';
import {MNDW_SELECT_TAG, MndwSelect} from './select.js';
import {type UiCloseReason, type UiLayerOptions, type UiOverlayProvider, setOverlayProvider} from '../overlay.js';

beforeAll(() => {
  if (!customElements.get(MNDW_OPTION_TAG)) {
    customElements.define(MNDW_OPTION_TAG, MndwOption);
  }

  if (!customElements.get(MNDW_SELECT_PANEL_TAG)) {
    customElements.define(MNDW_SELECT_PANEL_TAG, MndwSelectPanel);
  }

  if (!customElements.get(MNDW_SELECT_TAG)) {
    customElements.define(MNDW_SELECT_TAG, MndwSelect);
  }
});

afterEach(() => {
  setOverlayProvider(undefined);
  document.body.innerHTML = '';
  setViewport(DEFAULT_INNER_WIDTH, DEFAULT_INNER_HEIGHT);
});

const MARKUP = `
  <mndw-select label="Interface" placeholder="-- Choose --">
    <mndw-option value="isp">Wired</mndw-option>
    <mndw-option value="wifi">Wireless</mndw-option>
  </mndw-select>
`;

const DEFAULT_INNER_WIDTH = window.innerWidth;
const DEFAULT_INNER_HEIGHT = window.innerHeight;

function setViewport(width: number, height = 768): void {
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: width});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: height});
}

async function mount(markup = MARKUP): Promise<MndwSelect> {
  document.body.innerHTML = markup;

  const element = document.body.firstElementChild as MndwSelect;

  await element.updateComplete;

  return element;
}

function trigger(element: MndwSelect): HTMLButtonElement {
  const found = element.shadowRoot?.querySelector('button');

  if (!found) {
    throw new Error('missing trigger');
  }

  return found;
}

function panel(): MndwSelectPanel | null {
  return document.querySelector(MNDW_SELECT_PANEL_TAG);
}

async function openPanel(element: MndwSelect): Promise<MndwSelectPanel> {
  trigger(element).click();
  await element.updateComplete;

  const found = panel();

  if (!found) {
    throw new Error('panel did not open');
  }

  await found.updateComplete;
  await Promise.resolve();

  return found;
}

interface FakeLayer {
  contentElement: HTMLElement;
  closed: Promise<UiCloseReason>;
  close: ReturnType<typeof vi.fn>;
  reposition: ReturnType<typeof vi.fn>;
  settle: (reason: UiCloseReason) => void;
}

function fakeProvider(): {
  provider: UiOverlayProvider;
  calls: UiLayerOptions[];
  layers: FakeLayer[];
} {
  const calls: UiLayerOptions[] = [];
  const layers: FakeLayer[] = [];
  const provider: UiOverlayProvider = {
    open(options: UiLayerOptions) {
      calls.push(options);

      const contentElement = document.createElement('div');

      document.body.appendChild(contentElement);

      let settle: (reason: UiCloseReason) => void = () => {};
      const closed = new Promise<UiCloseReason>((resolve) => {
        settle = resolve;
      });
      const layer: FakeLayer = {
        contentElement,
        closed,
        close: vi.fn(() => {
          contentElement.remove();
          settle('api');
        }),
        reposition: vi.fn(),
        settle: (reason: UiCloseReason) => {
          contentElement.remove();
          settle(reason);
        },
      };

      layers.push(layer);

      return layer;
    },
  };

  return {provider, calls, layers};
}

describe('<mndw-select> trigger', () => {
  it('shows the placeholder when nothing is selected', async () => {
    const element = await mount();

    expect(trigger(element).textContent).toContain('-- Choose --');
  });

  it('shows the label of the selected option', async () => {
    const element = await mount();

    element.value = 'wifi';
    await element.updateComplete;

    expect(trigger(element).textContent).toContain('Wireless');
  });

  it('is a combobox that reports collapsed state', async () => {
    const element = await mount();
    const button = trigger(element);

    expect(button.getAttribute('role')).toBe('combobox');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('names the trigger from the label', async () => {
    const element = await mount();

    expect(trigger(element).getAttribute('aria-label')).toBe('Interface');
  });
});

describe('<mndw-select> opening', () => {
  it('opens on click and reports expanded', async () => {
    const element = await mount();

    await openPanel(element);

    expect(element.open).toBe(true);
    expect(trigger(element).getAttribute('aria-expanded')).toBe('true');
  });

  it('passes the option model to the panel', async () => {
    const opened = await openPanel(await mount());

    expect(opened.options).toEqual([
      {value: 'isp', label: 'Wired', disabled: false},
      {value: 'wifi', label: 'Wireless', disabled: false},
    ]);
  });

  it('closes when the trigger is clicked again', async () => {
    const element = await mount();

    await openPanel(element);

    trigger(element).dispatchEvent(new Event('pointerdown', {bubbles: true, composed: true}));
    trigger(element).click();
    await element.updateComplete;

    expect(element.open).toBe(false);
    expect(panel()).toBeNull();
  });

  it('opens on ArrowDown from the trigger', async () => {
    const element = await mount();

    trigger(element).dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown'}));
    await element.updateComplete;

    expect(panel()).not.toBeNull();
  });

  it('does not open when disabled', async () => {
    const element = await mount(
      '<mndw-select disabled><mndw-option value="a">A</mndw-option></mndw-select>',
    );

    trigger(element).click();
    await element.updateComplete;

    expect(panel()).toBeNull();
  });

  it('applies panelClass to the panel element, so ::part() resolves', async () => {
    const element = await mount(
      '<mndw-select panel-class="demo"><mndw-option value="a">A</mndw-option></mndw-select>',
    );
    const opened = await openPanel(element);

    expect(opened.classList.contains('demo')).toBe(true);
    expect(opened.parentElement?.classList.contains('demo')).toBe(false);
  });

  it('accepts several space-separated panel classes', async () => {
    const element = await mount(
      '<mndw-select panel-class="a  b"><mndw-option value="x">X</mndw-option></mndw-select>',
    );
    const opened = await openPanel(element);

    expect(opened.classList.contains('a')).toBe(true);
    expect(opened.classList.contains('b')).toBe(true);
  });

  it('keeps panel class and sizing out of provider options', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    await openPanel(
      await mount(
        '<mndw-select panel-class="demo"><mndw-option value="a">A</mndw-option></mndw-select>',
      ),
    );

    expect(probe.calls[0]).not.toHaveProperty('className');
    expect(probe.calls[0]).not.toHaveProperty('maxHeight');
    expect(probe.calls[0]).toMatchObject({presentation: 'popover', title: 'Select option'});
  });

  it('sizes the layer content itself, since neither provider will', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    setViewport(1024, 768);

    const element = await mount();

    Object.defineProperty(trigger(element), 'getBoundingClientRect', {
      value: () => ({top: 100, bottom: 132, width: 200} as DOMRect),
      configurable: true,
    });

    const opened = await openPanel(element);
    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing overlay wrapper');
    }

    expect(wrapper.style.maxHeight).toBe('624px');
    expect(wrapper.style.overflowY).toBe('auto');
    expect(wrapper.style.maxWidth).toBe('calc(100vw - 16px)');
  });

  it('updates popover height when the viewport moves the trigger', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    setViewport(1024, 768);

    const element = await mount();
    let rect = {top: 100, bottom: 132, width: 200};

    Object.defineProperty(trigger(element), 'getBoundingClientRect', {
      value: () => rect as DOMRect,
      configurable: true,
    });

    const opened = await openPanel(element);
    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing overlay wrapper');
    }

    expect(wrapper.style.maxHeight).toBe('624px');

    rect = {top: 500, bottom: 532, width: 200};
    window.dispatchEvent(new Event('resize'));

    expect(wrapper.style.maxHeight).toBe('488px');
    expect(probe.layers[0].reposition).toHaveBeenCalledTimes(2);
  });

  it('opens a full-screen sheet at 600px without popover sizing', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    setViewport(600, 844);

    const element = await mount();
    const opened = await openPanel(element);
    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing sheet wrapper');
    }

    expect(probe.calls[0]).toMatchObject({
      presentation: 'sheet',
      title: 'Interface',
    });
    expect(opened.sheet).toBe(true);
    expect(wrapper.style.minWidth).toBe('');
    expect(wrapper.style.maxWidth).toBe('');
    expect(wrapper.style.maxHeight).toBe('');
    expect(wrapper.style.overflowY).toBe('');
  });

  it('uses popover presentation above the mobile breakpoint', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    setViewport(601, 844);

    const opened = await openPanel(await mount());

    expect(probe.calls[0]).toMatchObject({presentation: 'popover'});
    expect(opened.sheet).toBe(false);
  });

  it('uses a fallback sheet title when label is absent', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    setViewport(600, 844);
    await openPanel(await mount('<mndw-select><mndw-option value="a">A</mndw-option></mndw-select>'));

    expect(probe.calls[0]?.title).toBe('Select option');
  });

  it('gives the panel at least the trigger width', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();

    Object.defineProperty(element.shadowRoot?.querySelector('button') as HTMLElement, 'getBoundingClientRect', {
      value: () => ({top: 100, bottom: 132, width: 320} as DOMRect),
      configurable: true,
    });

    const opened = await openPanel(element);

    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing overlay wrapper');
    }

    expect(wrapper.style.minWidth).toBe('320px');
  });

  it('floors the panel width for a narrow trigger', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();

    Object.defineProperty(element.shadowRoot?.querySelector('button') as HTMLElement, 'getBoundingClientRect', {
      value: () => ({top: 100, bottom: 132, width: 60} as DOMRect),
      configurable: true,
    });

    const opened = await openPanel(element);

    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing overlay wrapper');
    }

    expect(wrapper.style.minWidth).toBe('180px');
  });

  it('uses the injected overlay provider', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    await openPanel(await mount());

    expect(probe.calls).toHaveLength(1);
  });

  it('repositions the layer only after the panel has rendered', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const opened = await openPanel(await mount());

    expect(probe.layers[0].reposition).toHaveBeenCalledTimes(1);
    expect(opened.shadowRoot?.querySelectorAll('[role="option"]').length).toBe(2);
  });
});

describe('<mndw-select> selection', () => {
  it('updates value and emits mndwchange on panel select', async () => {
    const element = await mount();
    const onChange = vi.fn();

    element.addEventListener('mndwchange', onChange);

    const opened = await openPanel(element);

    opened.dispatchEvent(new CustomEvent('mndwpanelselect', {detail: {value: 'wifi'}}));
    await element.updateComplete;

    expect(element.value).toBe('wifi');
    expect((onChange.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'wifi'});
  });

  it('emits a composed event that escapes the shadow root', async () => {
    const element = await mount();
    const onChange = vi.fn();

    document.body.addEventListener('mndwchange', onChange);

    const opened = await openPanel(element);

    opened.dispatchEvent(new CustomEvent('mndwpanelselect', {detail: {value: 'isp'}}));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('closes the panel after selecting', async () => {
    const element = await mount();
    const opened = await openPanel(element);

    opened.dispatchEvent(new CustomEvent('mndwpanelselect', {detail: {value: 'isp'}}));
    await element.updateComplete;

    expect(panel()).toBeNull();
    expect(element.open).toBe(false);
  });

  it('restores focus to the trigger after selecting', async () => {
    const element = await mount();
    const focus = vi.spyOn(trigger(element), 'focus');
    const opened = await openPanel(element);

    opened.dispatchEvent(new CustomEvent('mndwpanelselect', {detail: {value: 'isp'}}));
    await element.updateComplete;

    expect(focus).toHaveBeenCalled();
  });

  it('restores focus to the trigger on panel dismiss', async () => {
    const element = await mount();
    const focus = vi.spyOn(trigger(element), 'focus');
    const opened = await openPanel(element);

    opened.dispatchEvent(new CustomEvent('mndwpaneldismiss', {detail: {restoreFocus: true}}));
    await element.updateComplete;

    expect(focus).toHaveBeenCalled();
  });
});

describe('<mndw-select> externally closed layers', () => {
  it('restores focus when the layer closes with reason escape', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const focus = vi.spyOn(trigger(element), 'focus');

    await openPanel(element);
    probe.layers[0].settle('escape');
    await probe.layers[0].closed;
    await element.updateComplete;

    expect(focus).toHaveBeenCalled();
    expect(element.open).toBe(false);
  });

  it('does NOT restore focus when another element already holds it', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const elsewhere = document.createElement('input');

    document.body.appendChild(elsewhere);

    const focus = vi.spyOn(trigger(element), 'focus');

    await openPanel(element);

    (probe.layers[0].contentElement.firstElementChild as HTMLElement).dispatchEvent(
      new FocusEvent('focusout', {bubbles: true, relatedTarget: elsewhere}),
    );
    elsewhere.focus();
    probe.layers[0].settle('outside');
    await probe.layers[0].closed;
    await element.updateComplete;

    expect(focus).not.toHaveBeenCalled();
    expect(element.open).toBe(false);
  });

  it('DOES restore focus when an outside dismissal orphans it', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const focus = vi.spyOn(trigger(element), 'focus');

    await openPanel(element);
    probe.layers[0].settle('outside');
    await probe.layers[0].closed;
    await element.updateComplete;

    expect(focus).toHaveBeenCalled();
  });

  it('restores focus when the layer closes with reason api', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const focus = vi.spyOn(trigger(element), 'focus');

    await openPanel(element);
    probe.layers[0].settle('api');
    await probe.layers[0].closed;
    await element.updateComplete;

    expect(focus).toHaveBeenCalled();
  });

  it('does not restore focus once the host is disconnected', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const focus = vi.spyOn(trigger(element), 'focus');

    await openPanel(element);
    element.remove();
    await Promise.resolve();

    expect(focus).not.toHaveBeenCalled();
  });

  it('marks itself closed exactly once when both paths fire', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const opened = await openPanel(element);

    opened.dispatchEvent(new CustomEvent('mndwpanelselect', {detail: {value: 'isp'}}));
    await element.updateComplete;
    await probe.layers[0].closed;

    expect(probe.layers[0].close).toHaveBeenCalledTimes(1);
    expect(element.open).toBe(false);
  });
});

describe('<mndw-select> option mutation', () => {
  it('re-reads options when a child option is relabelled in place', async () => {
    const element = await mount();
    const opened = await openPanel(element);
    const option = element.querySelector<MndwOption>(MNDW_OPTION_TAG);

    if (!option) {
      throw new Error('missing option');
    }

    option.textContent = 'Wired (WAN)';
    await Promise.resolve();
    await opened.updateComplete;

    expect(opened.options[0].label).toBe('Wired (WAN)');
  });

  it('re-reads options when a child option becomes disabled', async () => {
    const element = await mount();
    const opened = await openPanel(element);
    const option = element.querySelector<MndwOption>(MNDW_OPTION_TAG);

    if (!option) {
      throw new Error('missing option');
    }

    option.disabled = true;
    await opened.updateComplete;

    expect(opened.options[0].disabled).toBe(true);
  });

  it('refreshes the trigger label when the selected option is relabelled', async () => {
    const element = await mount();

    element.value = 'wifi';
    await element.updateComplete;

    const option = element.querySelectorAll(MNDW_OPTION_TAG)[1] as MndwOption;

    option.textContent = 'Wireless 5GHz';
    await Promise.resolve();
    await element.updateComplete;

    expect(trigger(element).textContent).toContain('Wireless 5GHz');
  });
});

describe('<mndw-select> teardown', () => {
  it('closes the layer when the host is removed from the document', async () => {
    const element = await mount();

    await openPanel(element);
    element.remove();
    await Promise.resolve();

    expect(panel()).toBeNull();
  });

  it('reopens cleanly after the layer closes externally', async () => {
    const element = await mount();
    const opened = await openPanel(element);

    opened.dispatchEvent(new CustomEvent('mndwpaneldismiss', {detail: {restoreFocus: true}}));
    await element.updateComplete;

    await openPanel(element);

    expect(element.open).toBe(true);
  });

  it('picks up options added after first render', async () => {
    const element = await mount();
    const extra = document.createElement(MNDW_OPTION_TAG) as MndwOption;

    extra.value = 'lte';
    extra.textContent = 'LTE';
    element.appendChild(extra);
    await element.updateComplete;

    const opened = await openPanel(element);

    expect(opened.options).toHaveLength(3);
  });
});
