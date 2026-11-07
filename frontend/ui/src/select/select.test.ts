// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MNDW_OPTION_TAG, MndwOption} from './option.js';
import {MNDW_ICON_TAG, MndwIcon} from '../icon/icon.js';
import {MNDW_SELECT_PANEL_TAG, MndwSelectPanel} from './select-panel.js';
import {MNDW_SELECT_TAG, MndwSelect} from './select.js';
import {deepActiveElement} from '../focus.js';
import {setMndwUiLocale} from '../i18n.js';
import {type UiCloseReason, type UiLayerOptions, type UiOverlayProvider, setOverlayProvider} from '../overlay.js';
import {defineComponents, mount as mountComponent, resetUiTestState} from '../testing/index.js';

defineComponents(
  [MNDW_OPTION_TAG, MndwOption],
  [MNDW_SELECT_PANEL_TAG, MndwSelectPanel],
  [MNDW_SELECT_TAG, MndwSelect],
  [MNDW_ICON_TAG, MndwIcon],
);

afterEach(() => {
  resetUiTestState();
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
  return mountComponent(markup, MNDW_SELECT_TAG);
}

function trigger(element: MndwSelect): HTMLElement {
  const found = element.shadowRoot?.querySelector<HTMLElement>('[part="trigger"]');

  if (!found) {
    throw new Error('missing trigger part');
  }

  return found;
}

async function nextAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function keydown(
  target: HTMLElement | null,
  key: string,
  options: {altKey?: boolean} = {},
): KeyboardEvent {
  if (!target) {
    throw new Error('missing keydown target');
  }

  const event = new KeyboardEvent('keydown', {
    key,
    altKey: options.altKey ?? false,
    bubbles: true,
    cancelable: true,
    composed: true,
  });

  target.dispatchEvent(event);

  return event;
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
  setTitle: ReturnType<typeof vi.fn>;
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
        setTitle: vi.fn(),
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
  it('is form-associated and exposes listbox button semantics on the trigger', async () => {
    const element = await mount();
    const button = trigger(element);

    expect(MndwSelect.formAssociated).toBe(true);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toBe('Interface');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(element.hasAttribute('tabindex')).toBe(false);
  });

  it('opens when the host receives activation', async () => {
    const element = await mount();

    element.click();
    await element.updateComplete;

    expect(element.open).toBe(true);
  });

  it('updates an open fallback overlay title when the locale changes', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount('<mndw-select></mndw-select>');

    await openPanel(element);
    expect(probe.calls[0]?.title).toBe('Select option');

    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(probe.layers[0]?.setTitle).toHaveBeenCalledWith('Выберите вариант');
  });

  it('shows the placeholder when nothing is selected', async () => {
    const element = await mount();

    expect(trigger(element).textContent).toContain('-- Choose --');
  });

  it('updates generated placeholder while preserving an authored property', async () => {
    const element = await mount('<mndw-select></mndw-select>');

    setMndwUiLocale('ru');
    await element.updateComplete;
    expect(trigger(element).textContent).toContain('Выберите…');

    element.placeholder = 'Custom placeholder';
    await element.updateComplete;
    setMndwUiLocale('en');
    await element.updateComplete;

    expect(trigger(element).textContent).toContain('Custom placeholder');
  });

  it('shows the label of the selected option', async () => {
    const element = await mount();

    element.value = 'wifi';
    await element.updateComplete;

    expect(trigger(element).textContent).toContain('Wireless');
  });

  it('has a named button trigger that reports collapsed state', async () => {
    const element = await mount();

    expect(trigger(element).getAttribute('aria-label')).toBe('Interface');
    expect(trigger(element).getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger(element).getAttribute('aria-expanded')).toBe('false');
  });

  it('names the trigger from the label', async () => {
    const element = await mount();

    expect(element.label).toBe('Interface');
  });

  it('restores the authored value or first option on form reset', async () => {
    const element = await mount();

    element.value = 'wifi';
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe('isp');
  });

  it('restores a string state without requiring a matching option', async () => {
    const element = await mount();

    element.formStateRestoreCallback('saved-value', 'restore');
    await element.updateComplete;

    expect(element.value).toBe('saved-value');
  });

  it('announces invalid state on the trigger', async () => {
    const element = await mount();

    element.required = true;
    element.invalid = true;
    await element.updateComplete;

    expect(trigger(element).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('<mndw-select> opening', () => {
  it('moves DOM focus into the listbox while its popup is open', async () => {
    const element = await mount();
    const nativeFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')?.value as (
      this: HTMLElement,
    ) => void;
    let optionFocusCalls = 0;
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function(this: HTMLElement): void {
      if (this.getAttribute('role') === 'option') {
        optionFocusCalls += 1;
      }

      nativeFocus.call(this);
    });

    trigger(element).focus();
    keydown(trigger(element), 'ArrowDown');

    const opened = panel();

    if (!opened) {
      throw new Error('panel did not open');
    }

    await opened.updateComplete;
    await Promise.resolve();

    expect(deepActiveElement()).toBe(opened.listboxElement);
    expect(optionFocusCalls).toBe(0);
    expect(opened.listboxElement?.getAttribute('aria-activedescendant')).toBe(opened.activeOptionElement?.id);
    focusSpy.mockRestore();
  });

  it('opens on click and reports expanded', async () => {
    const element = await mount();

    await openPanel(element);

    expect(element.open).toBe(true);
    expect(trigger(element).getAttribute('aria-expanded')).toBe('true');
  });

  it('passes the option model to the panel', async () => {
    const opened = await openPanel(await mount());

    expect(opened.options.map(({value, label, disabled}) => ({value, label, disabled}))).toEqual([
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

  it.each([
    {key: 'ArrowDown', index: 0, label: 'Down opens on first'},
    {key: 'ArrowUp', index: 1, label: 'Up opens on last'},
    {key: 'Enter', index: 0, label: 'Enter opens on selected'},
    {key: ' ', index: 0, label: 'Space opens on selected'},
    {key: 'ArrowDown', altKey: true, index: 0, label: 'Alt+Down opens on selected'},
  ])('$label', async ({key, altKey, index}) => {
    const element = await mount();

    trigger(element).focus();
    keydown(trigger(element), key, {altKey});
    await element.updateComplete;

    const opened = panel();

    if (!opened) {
      throw new Error('panel did not open');
    }

    await opened.updateComplete;

    expect(opened.activeIndex).toBe(index);
    expect(deepActiveElement()).toBe(opened.listboxElement);
  });

  it.each([
    {key: 'Home', preset: 'wifi', activeIndex: 0, label: 'opens on Home with the first enabled option active'},
    {key: 'End', preset: undefined, activeIndex: 1, label: 'opens on End with the last enabled option active'},
  ])('$label', async ({key, preset, activeIndex}) => {
    const element = await mount();

    if (preset !== undefined) {
      element.value = preset;
      await element.updateComplete;
    }

    keydown(trigger(element), key);
    await element.updateComplete;

    const opened = panel();

    if (!opened) {
      throw new Error('panel did not open');
    }

    await opened.updateComplete;

    expect(opened.activeIndex).toBe(activeIndex);
  });

  it('opens on printable typeahead and makes the matching option active', async () => {
    const element = await mount();

    trigger(element).focus();
    keydown(trigger(element), 'w');
    await element.updateComplete;

    const opened = panel();

    if (!opened) {
      throw new Error('panel did not open');
    }

    await opened.updateComplete;

    expect(opened.activeIndex).toBe(1);
    expect(deepActiveElement()).toBe(opened.listboxElement);
  });

  it('moves among enabled options without wrapping', async () => {
    const element = await mount(`
      <mndw-select label="Interface">
        <mndw-option value="isp">Wired</mndw-option>
        <mndw-option value="disabled" disabled>Disabled</mndw-option>
        <mndw-option value="wifi">Wireless</mndw-option>
      </mndw-select>
    `);
    const opened = await openPanel(element);

    keydown(opened.listboxElement, 'ArrowDown');
    await opened.updateComplete;
    expect(opened.activeIndex).toBe(2);

    keydown(opened.listboxElement, 'ArrowDown');
    expect(opened.activeIndex).toBe(2);

    keydown(opened.listboxElement, 'ArrowUp');
    await opened.updateComplete;
    expect(opened.activeIndex).toBe(0);
    expect(deepActiveElement()).toBe(opened.listboxElement);
  });

  it('does not emit aria-controls when ElementInternals support is absent', async () => {
    const element = await mount();

    expect(element.hasAttribute('aria-controls')).toBe(false);
  });

  it('does not open when disabled', async () => {
    const element = await mount(
      '<mndw-select disabled><mndw-option value="a">A</mndw-option></mndw-select>',
    );

    trigger(element).click();
    await element.updateComplete;

    expect(panel()).toBeNull();
  });

  it('forwards panelClass to the overlay provider', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount(
      '<mndw-select panel-class="demo"><mndw-option value="a">A</mndw-option></mndw-select>',
    );
    const opened = await openPanel(element);

    expect(probe.calls[0]?.className).toBe('demo');
    expect(opened.classList.contains('demo')).toBe(false);
  });

  it('preserves several space-separated panel classes', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount(
      '<mndw-select panel-class="a  b"><mndw-option value="x">X</mndw-option></mndw-select>',
    );

    await openPanel(element);

    expect(probe.calls[0]?.className).toBe('a  b');
  });

  it('forwards panel class while keeping sizing in the select', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    await openPanel(
      await mount(
        '<mndw-select panel-class="demo"><mndw-option value="a">A</mndw-option></mndw-select>',
      ),
    );

    expect(probe.calls[0]).toHaveProperty('className', 'demo');
    expect(probe.calls[0]).not.toHaveProperty('maxHeight');
    expect(probe.calls[0]).toMatchObject({presentation: 'popover', title: 'Select option'});
  });

  it('sizes the layer content itself, since neither provider will', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    setViewport(1024, 768);

    const element = await mount();

    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({top: 100, bottom: 132, width: 200} as DOMRect),
      configurable: true,
    });

    const opened = await openPanel(element);
    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing overlay wrapper');
    }

    expect(wrapper.style.maxHeight).toBe('620px');
    expect(wrapper.style.minWidth).toBe('200px');
    expect(wrapper.style.overflow).toBe('hidden');
    expect(wrapper.style.display).toBe('flex');
    expect(wrapper.style.flexDirection).toBe('column');
    expect(opened.style.maxHeight).toBe('');
    expect(wrapper.style.maxWidth).toBe('calc(100vw - 16px)');
  });

  it('updates popover height when the viewport moves the trigger', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    setViewport(1024, 768);

    const element = await mount();
    let rect = {top: 100, bottom: 132, width: 200};

    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => rect as DOMRect,
      configurable: true,
    });

    const opened = await openPanel(element);
    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing overlay wrapper');
    }

    expect(wrapper.style.maxHeight).toBe('620px');

    rect = {top: 500, bottom: 532, width: 200};
    window.dispatchEvent(new Event('resize'));

    expect(wrapper.style.maxHeight).toBe('484px');
    expect(probe.layers[0].reposition).toHaveBeenCalledTimes(1);
  });

  it('updates popover sizing when anchor geometry changes without a viewport event', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    setViewport(1024, 768);

    const element = await mount();
    let rect = {top: 100, bottom: 132, width: 200};

    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => rect as DOMRect,
      configurable: true,
    });

    const opened = await openPanel(element);
    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing overlay wrapper');
    }

    await nextAnimationFrame();
    rect = {top: 500, bottom: 532, width: 320};
    await nextAnimationFrame();

    expect(wrapper.style.maxHeight).toBe('484px');
    expect(wrapper.style.minWidth).toBe('320px');
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
    expect(wrapper.style.overflow).toBe('');
    expect(wrapper.style.display).toBe('');
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

  it.each([
    {triggerWidth: 320, minWidth: '320px', label: 'gives the panel at least the trigger width'},
    {triggerWidth: 60, minWidth: '180px', label: 'floors the panel width for a narrow trigger'},
  ])('$label', async ({triggerWidth, minWidth}) => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();

    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({top: 100, bottom: 132, width: triggerWidth} as DOMRect),
      configurable: true,
    });

    const opened = await openPanel(element);
    const wrapper = opened.parentElement;

    if (!wrapper) {
      throw new Error('missing overlay wrapper');
    }

    expect(wrapper.style.minWidth).toBe(minWidth);
  });

  it('uses the injected overlay provider', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);
    await openPanel(await mount());

    expect(probe.calls).toHaveLength(1);
  });

  it('keeps listbox focus and updates its active descendant', async () => {
    const element = await mount();
    const opened = await openPanel(element);

    expect(deepActiveElement()).toBe(opened.listboxElement);
    expect(opened.listboxElement?.getAttribute('aria-activedescendant')).toBe(opened.activeOptionElement?.id);

    keydown(opened.listboxElement, 'ArrowDown');
    await opened.updateComplete;

    expect(opened.listboxElement?.getAttribute('aria-activedescendant')).toBe(opened.activeOptionElement?.id);
  });

  it('repositions the layer only after the panel has rendered', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const opened = await openPanel(await mount());

    expect(probe.layers[0].reposition).not.toHaveBeenCalled();

    await nextAnimationFrame();

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

  it.each([
    {
      eventName: 'mndwpanelselect',
      detail: {value: 'isp'},
      label: 'restores focus to the trigger after selecting',
    },
    {
      eventName: 'mndwpaneldismiss',
      detail: {restoreFocus: true},
      label: 'restores focus to the trigger on panel dismiss',
    },
  ])('$label', async ({eventName, detail}) => {
    const element = await mount();
    const focus = vi.spyOn(element, 'focus');
    const opened = await openPanel(element);

    opened.dispatchEvent(new CustomEvent(eventName, {detail}));
    await element.updateComplete;

    expect(focus).toHaveBeenCalled();
  });
});

describe('<mndw-select> externally closed layers', () => {
  it('restores focus when the layer closes with reason escape', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const focus = vi.spyOn(element, 'focus');

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

    const focus = vi.spyOn(element, 'focus');

    await openPanel(element);
    focus.mockClear();

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

  it.each(
    [
      {reason: 'outside', label: 'DOES restore focus when an outside dismissal orphans it'},
      {reason: 'api', label: 'restores focus when the layer closes with reason api'},
    ] as const,
  )('$label', async ({reason}) => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const focus = vi.spyOn(element, 'focus');

    await openPanel(element);
    probe.layers[0].settle(reason);
    await probe.layers[0].closed;
    await element.updateComplete;

    expect(focus).toHaveBeenCalled();
  });

  it('does not restore focus once the host is disconnected', async () => {
    const probe = fakeProvider();

    setOverlayProvider(probe.provider);

    const element = await mount();
    const focus = vi.spyOn(element, 'focus');

    await openPanel(element);
    focus.mockClear();
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

    const option = element.querySelectorAll(MNDW_OPTION_TAG)[1];

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
    const extra = document.createElement(MNDW_OPTION_TAG);

    extra.value = 'lte';
    extra.textContent = 'LTE';
    element.appendChild(extra);
    await element.updateComplete;

    const opened = await openPanel(element);

    expect(opened.options).toHaveLength(3);
  });
});

describe('<mndw-select> indicator icon', () => {
  it('renders a decorative chevron-down icon', async () => {
    const element = await mountComponent(MARKUP, MNDW_SELECT_TAG);
    const indicator = element.shadowRoot?.querySelector('[part="indicator"] mndw-icon');

    expect(indicator?.getAttribute('name')).toBe('chevron-down');
  });
});
