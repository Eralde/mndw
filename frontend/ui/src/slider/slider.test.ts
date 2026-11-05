// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_FIELD_TAG, MndwField} from '../field/field.js';
import {defineComponents, mount, press, settle} from '../testing/index.js';
import {MNDW_SLIDER_TAG, MndwSlider} from './slider.js';

defineComponents(
  [MNDW_SLIDER_TAG, MndwSlider],
  [MNDW_FIELD_TAG, MndwField],
);

/** happy-dom lays nothing out, so the drag geometry comes from a stubbed track rect. */
function stubTrack(element: MndwSlider, left = 0, width = 200): void {
  const track = element.shadowRoot?.querySelector('[part="track"]');

  if (!track) {
    throw new Error('missing track');
  }

  track.getBoundingClientRect = (): DOMRect => new DOMRect(left, 0, width, 8);
}

async function pointer(
  element: MndwSlider,
  type: string,
  clientX: number,
  target: EventTarget = element,
): Promise<void> {
  target.dispatchEvent(
    new PointerEvent(type, {clientX, pointerId: 1, isPrimary: true, bubbles: true, composed: true, cancelable: true}),
  );
  await element.updateComplete;
}

function detailValues(spy: ReturnType<typeof vi.fn>): number[] {
  return spy.mock.calls.map((call) => (call[0] as CustomEvent<{value: number}>).detail.value);
}

describe('<mndw-slider> semantics', () => {
  it('applies the documented defaults', async () => {
    const element = await mount('<mndw-slider></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.min).toBe(0);
    expect(element.max).toBe(100);
    expect(element.step).toBe(1);
    expect(element.value).toBe(0);
    expect(element.valueText).toBe('');
    expect(element.disabled).toBe(false);
    expect(element.required).toBe(false);
    expect(element.invalid).toBe(false);
    expect(element.name).toBe('');
  });

  it('starts at min when no value is authored', async () => {
    const element = await mount('<mndw-slider min="10" max="20"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.value).toBe(10);
  });

  it('carries slider semantics and the tab stop on the host', async () => {
    const element = await mount('<mndw-slider value="30"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.getAttribute('role')).toBe('slider');
    expect(element.getAttribute('aria-valuenow')).toBe('30');
    expect(element.getAttribute('aria-valuemin')).toBe('0');
    expect(element.getAttribute('aria-valuemax')).toBe('100');
    expect(element.getAttribute('aria-orientation')).toBe('horizontal');
    expect(element.getAttribute('aria-disabled')).toBe('false');
    expect(element.tabIndex).toBe(0);
  });

  it('omits aria-valuetext while valueText is empty', async () => {
    const element = await mount('<mndw-slider value="30"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.hasAttribute('aria-valuetext')).toBe(false);

    element.valueText = '30 percent';
    await element.updateComplete;

    expect(element.getAttribute('aria-valuetext')).toBe('30 percent');

    element.valueText = '';
    await element.updateComplete;

    expect(element.hasAttribute('aria-valuetext')).toBe(false);
  });

  it('takes valueText from its attribute without reflecting an empty one back', async () => {
    const element = await mount('<mndw-slider value="30" value-text="Balanced"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.valueText).toBe('Balanced');

    element.valueText = '';
    await element.updateComplete;

    expect(element.hasAttribute('value-text')).toBe(true);
    expect(element.getAttribute('value-text')).toBe('Balanced');
  });

  it('reflects configuration but never the value', async () => {
    const element = await mount('<mndw-slider value="30"></mndw-slider>', MNDW_SLIDER_TAG);

    element.min = 10;
    element.max = 50;
    element.step = 5;
    element.value = 25;
    await element.updateComplete;

    expect(element.getAttribute('min')).toBe('10');
    expect(element.getAttribute('max')).toBe('50');
    expect(element.getAttribute('step')).toBe('5');
    expect(element.getAttribute('value')).toBe('30');
  });

  it('exposes track, fill, thumb, and output parts', async () => {
    const element = await mount('<mndw-slider value="25"></mndw-slider>', MNDW_SLIDER_TAG);
    const root = element.shadowRoot;

    expect(root?.querySelector('[part="track"]')).not.toBeNull();
    expect(root?.querySelector('[part="fill"]')).not.toBeNull();
    expect(root?.querySelector('[part="thumb"]')).not.toBeNull();
    expect(root?.querySelector('[part="output"]')?.textContent?.trim()).toBe('25');
  });

  it('shows valueText in the output when it is set', async () => {
    const element = await mount('<mndw-slider value="25" value-text="Quarter"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.shadowRoot?.querySelector('[part="output"]')?.textContent?.trim()).toBe('Quarter');
  });

  it('keeps no interactive descendant inside the shadow root', async () => {
    const element = await mount('<mndw-slider></mndw-slider>', MNDW_SLIDER_TAG);
    const root = element.shadowRoot;

    expect(root?.querySelector('button, input, a, [tabindex]')).toBeNull();
    expect(root?.querySelector('[part="output"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.querySelector('[part="track"]')?.hasAttribute('role')).toBe(false);
  });
});

describe('<mndw-slider> value normalization', () => {
  it('clamps a value outside the range', async () => {
    const element = await mount('<mndw-slider min="10" max="20" value="99"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.value).toBe(20);

    element.value = -5;
    await element.updateComplete;

    expect(element.value).toBe(10);
  });

  it('snaps to the step grid measured from min', async () => {
    const element = await mount('<mndw-slider min="1" max="21" step="5" value="8"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.value).toBe(6);

    element.value = 14;
    await element.updateComplete;

    expect(element.value).toBe(16);
  });

  it('keeps fractional steps free of binary drift', async () => {
    const element = await mount('<mndw-slider min="0" max="1" step="0.1" value="0.3"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.value).toBe(0.3);

    element.value = 0.7000001;
    await element.updateComplete;

    expect(element.value).toBe(0.7);
  });

  it('stops at the last aligned step below max', async () => {
    const element = await mount('<mndw-slider min="0" max="10" step="3" value="10"></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.value).toBe(9);
  });

  it('follows a constraint that moves past the current value', async () => {
    const element = await mount('<mndw-slider value="10"></mndw-slider>', MNDW_SLIDER_TAG);

    element.min = 40;
    await element.updateComplete;

    expect(element.value).toBe(40);

    element.max = 30;
    await element.updateComplete;

    expect(element.value).toBe(30);
  });

  it('falls back to the documented defaults for unparseable configuration', async () => {
    const element = await mount(
      '<mndw-slider min="low" max="high" step="none" value="mid"></mndw-slider>',
      MNDW_SLIDER_TAG,
    );

    expect(element.min).toBe(0);
    expect(element.max).toBe(100);
    expect(element.step).toBe(1);
    expect(element.value).toBe(0);
  });
});

describe('<mndw-slider> keyboard', () => {
  it('steps with the arrow keys and commits on the same keystroke', async () => {
    const element = await mount('<mndw-slider value="50"></mndw-slider>', MNDW_SLIDER_TAG);
    const inputs = vi.fn();
    const changes = vi.fn();

    element.addEventListener('mndwinput', inputs);
    element.addEventListener('mndwchange', changes);

    const right = await press(element, 'ArrowRight');

    expect(element.value).toBe(51);
    expect(right.defaultPrevented).toBe(true);
    expect(detailValues(inputs)).toEqual([51]);
    expect(detailValues(changes)).toEqual([51]);

    await press(element, 'ArrowLeft');
    await press(element, 'ArrowUp');
    await press(element, 'ArrowDown');

    expect(element.value).toBe(50);
    expect(inputs).toHaveBeenCalledTimes(4);
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it('jumps a tenth of the range with PageUp and PageDown', async () => {
    const element = await mount('<mndw-slider value="50"></mndw-slider>', MNDW_SLIDER_TAG);

    await press(element, 'PageUp');

    expect(element.value).toBe(60);

    await press(element, 'PageDown');

    expect(element.value).toBe(50);
  });

  it('never pages by less than a step', async () => {
    const element = await mount('<mndw-slider min="0" max="10" step="4" value="0"></mndw-slider>', MNDW_SLIDER_TAG);

    await press(element, 'PageUp');

    expect(element.value).toBe(4);
  });

  it('jumps to the bounds with Home and End', async () => {
    const element = await mount('<mndw-slider min="5" max="25" value="10"></mndw-slider>', MNDW_SLIDER_TAG);

    await press(element, 'End');

    expect(element.value).toBe(25);

    await press(element, 'Home');

    expect(element.value).toBe(5);
  });

  it('emits nothing when a keystroke cannot move the value', async () => {
    const element = await mount('<mndw-slider max="10" value="10"></mndw-slider>', MNDW_SLIDER_TAG);
    const inputs = vi.fn();
    const changes = vi.fn();

    element.addEventListener('mndwinput', inputs);
    element.addEventListener('mndwchange', changes);
    await press(element, 'ArrowRight');
    await press(element, 'End');

    expect(element.value).toBe(10);
    expect(inputs).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
  });

  it('ignores keys outside the slider matrix', async () => {
    const element = await mount('<mndw-slider value="50"></mndw-slider>', MNDW_SLIDER_TAG);
    const other = await press(element, 'a');

    expect(element.value).toBe(50);
    expect(other.defaultPrevented).toBe(false);
  });

  it('does not move while disabled and leaves the tab order', async () => {
    const element = await mount('<mndw-slider value="50" disabled></mndw-slider>', MNDW_SLIDER_TAG);
    const inputs = vi.fn();

    element.addEventListener('mndwinput', inputs);
    await press(element, 'ArrowRight');

    expect(element.value).toBe(50);
    expect(inputs).not.toHaveBeenCalled();
    expect(element.getAttribute('aria-disabled')).toBe('true');
    expect(element.tabIndex).toBe(-1);
  });

  it('stays disabled under a fieldset and recovers when it is released', async () => {
    const element = await mount('<mndw-slider value="50"></mndw-slider>', MNDW_SLIDER_TAG);

    element.formDisabledCallback(true);
    await element.updateComplete;
    await press(element, 'ArrowRight');

    expect(element.value).toBe(50);
    expect(element.getAttribute('aria-disabled')).toBe('true');

    element.formDisabledCallback(false);
    await element.updateComplete;
    await press(element, 'ArrowRight');

    expect(element.value).toBe(51);
  });

  it('emits nothing for a programmatic change', async () => {
    const element = await mount('<mndw-slider value="50"></mndw-slider>', MNDW_SLIDER_TAG);
    const inputs = vi.fn();
    const changes = vi.fn();

    element.addEventListener('mndwinput', inputs);
    element.addEventListener('mndwchange', changes);
    element.value = 70;
    await element.updateComplete;

    expect(inputs).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('<mndw-slider> pointer drag', () => {
  it('jumps on pointerdown and commits once on pointerup', async () => {
    const element = await mount('<mndw-slider value="0"></mndw-slider>', MNDW_SLIDER_TAG);
    const inputs = vi.fn();
    const changes = vi.fn();

    stubTrack(element);
    element.addEventListener('mndwinput', inputs);
    element.addEventListener('mndwchange', changes);

    await pointer(element, 'pointerdown', 50);

    expect(element.value).toBe(25);
    expect(detailValues(inputs)).toEqual([25]);
    expect(changes).not.toHaveBeenCalled();

    await pointer(element, 'pointerup', 50, window);

    expect(detailValues(changes)).toEqual([25]);
  });

  it('tracks pointer moves and commits the final value once', async () => {
    const element = await mount('<mndw-slider value="0"></mndw-slider>', MNDW_SLIDER_TAG);
    const inputs = vi.fn();
    const changes = vi.fn();

    stubTrack(element);
    element.addEventListener('mndwinput', inputs);
    element.addEventListener('mndwchange', changes);

    await pointer(element, 'pointerdown', 20);
    await pointer(element, 'pointermove', 100, window);
    await pointer(element, 'pointermove', 100, window);
    await pointer(element, 'pointermove', 300, window);

    expect(element.value).toBe(100);
    expect(detailValues(inputs)).toEqual([10, 50, 100]);

    await pointer(element, 'pointerup', 300, window);

    expect(detailValues(changes)).toEqual([100]);

    await pointer(element, 'pointermove', 20, window);

    expect(element.value).toBe(100);
  });

  it('commits on pointercancel', async () => {
    const element = await mount('<mndw-slider value="0"></mndw-slider>', MNDW_SLIDER_TAG);
    const changes = vi.fn();

    stubTrack(element);
    element.addEventListener('mndwchange', changes);

    await pointer(element, 'pointerdown', 80);
    await pointer(element, 'pointercancel', 80, window);

    expect(element.value).toBe(40);
    expect(detailValues(changes)).toEqual([40]);
  });

  it('does not commit a drag that ends where it started', async () => {
    const element = await mount('<mndw-slider value="25"></mndw-slider>', MNDW_SLIDER_TAG);
    const changes = vi.fn();

    stubTrack(element);
    element.addEventListener('mndwchange', changes);

    await pointer(element, 'pointerdown', 50);
    await pointer(element, 'pointermove', 120, window);
    await pointer(element, 'pointermove', 50, window);
    await pointer(element, 'pointerup', 50, window);

    expect(element.value).toBe(25);
    expect(changes).not.toHaveBeenCalled();
  });

  it('ignores the pointer while disabled', async () => {
    const element = await mount('<mndw-slider value="0" disabled></mndw-slider>', MNDW_SLIDER_TAG);
    const inputs = vi.fn();

    stubTrack(element);
    element.addEventListener('mndwinput', inputs);

    await pointer(element, 'pointerdown', 100);
    await pointer(element, 'pointermove', 150, window);

    expect(element.value).toBe(0);
    expect(inputs).not.toHaveBeenCalled();
  });

  it('stops tracking a pointer once it is disconnected', async () => {
    const element = await mount('<mndw-slider value="0"></mndw-slider>', MNDW_SLIDER_TAG);

    stubTrack(element);
    await pointer(element, 'pointerdown', 50);

    element.remove();
    await pointer(element, 'pointermove', 150, window);

    expect(element.value).toBe(25);
  });
});

describe('<mndw-slider> form lifecycle', () => {
  it('resets to the value attribute', async () => {
    const element = await mount('<mndw-slider value="30"></mndw-slider>', MNDW_SLIDER_TAG);

    element.value = 70;
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe(30);
  });

  it('resets to min when no value was authored', async () => {
    const element = await mount('<mndw-slider min="5" max="25"></mndw-slider>', MNDW_SLIDER_TAG);

    element.value = 20;
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe(5);
  });

  it('restores submitted state', async () => {
    const element = await mount('<mndw-slider></mndw-slider>', MNDW_SLIDER_TAG);

    element.formStateRestoreCallback('42', 'restore');
    await element.updateComplete;

    expect(element.value).toBe(42);

    element.formStateRestoreCallback('not a number', 'restore');
    await element.updateComplete;

    expect(element.value).toBe(42);
  });

  it('accepts required without announcing or enforcing it', async () => {
    const element = await mount('<mndw-slider required></mndw-slider>', MNDW_SLIDER_TAG);

    expect(element.required).toBe(true);
    expect(element.hasAttribute('aria-required')).toBe(false);
  });
});

describe('<mndw-slider> inside <mndw-field>', () => {
  it('is labelled by the field, since a slider has no label source of its own', async () => {
    document.body.innerHTML = '<mndw-field label="Volume"><mndw-slider></mndw-slider></mndw-field>';

    const field = document.body.querySelector<MndwField>(MNDW_FIELD_TAG);
    const element = document.body.querySelector<MndwSlider>(MNDW_SLIDER_TAG);

    if (!field || !element) {
      throw new Error('missing field or slider');
    }

    await settle(element);

    const label = field.querySelector<HTMLLabelElement>('label.mndw-field__label');

    expect(label?.hidden).toBe(false);
    expect(label?.htmlFor).toBe(element.id);
    expect(element.id).not.toBe('');
  });
});

interface FakeInternals {
  values: (string | File | FormData | null)[];
  states: (string | File | FormData | null)[];
  flags: ValidityStateFlags;
  role: string | null;
  ariaValueNow: string | null;
  ariaValueMin: string | null;
  ariaValueMax: string | null;
  ariaValueText: string | null;
  ariaOrientation: string | null;
  labelledBy: Element[];
}

const INTERNALS_TAG = 'mndw-slider-internals-probe';
let latestInternals: FakeInternals | null = null;
let stubLabels: HTMLLabelElement[] = [];

function createFakeInternals(): ElementInternals & {record: FakeInternals} {
  const record: FakeInternals = {
    values: [],
    states: [],
    flags: {},
    role: null,
    ariaValueNow: null,
    ariaValueMin: null,
    ariaValueMax: null,
    ariaValueText: null,
    ariaOrientation: null,
    labelledBy: [],
  };

  return {
    record,
    states: new Set<string>(),
    get labels(): HTMLLabelElement[] {
      return stubLabels;
    },
    setFormValue(value: string | File | FormData | null, state?: string | File | FormData | null): void {
      record.values.push(value);
      record.states.push(state ?? null);
    },
    setValidity(flags: ValidityStateFlags): void {
      record.flags = flags;
    },
    set role(value: string | null) {
      record.role = value;
    },
    set ariaValueNow(value: string | null) {
      record.ariaValueNow = value;
    },
    set ariaValueMin(value: string | null) {
      record.ariaValueMin = value;
    },
    set ariaValueMax(value: string | null) {
      record.ariaValueMax = value;
    },
    set ariaValueText(value: string | null) {
      record.ariaValueText = value;
    },
    set ariaOrientation(value: string | null) {
      record.ariaOrientation = value;
    },
    set ariaLabelledByElements(value: Element[]) {
      record.labelledBy = value;
    },
  } as unknown as ElementInternals & {record: FakeInternals};
}

// happy-dom 17 has no `HTMLElement.prototype.attachInternals`, so the form-value, role, and validity
// paths are covered against a stub for the duration of this block.
describe('<mndw-slider> against ElementInternals', () => {
  let previous: PropertyDescriptor | undefined;

  beforeAll(() => {
    if (!customElements.get(INTERNALS_TAG)) {
      customElements.define(INTERNALS_TAG, class extends MndwSlider {});
    }
  });

  beforeEach(() => {
    stubLabels = [];
    previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'attachInternals');
    Object.defineProperty(HTMLElement.prototype, 'attachInternals', {
      configurable: true,
      writable: true,
      value(): ElementInternals {
        const internals = createFakeInternals();

        latestInternals = internals.record;

        return internals;
      },
    });
  });

  afterEach(() => {
    if (previous) {
      Object.defineProperty(HTMLElement.prototype, 'attachInternals', previous);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'attachInternals');
    }

    latestInternals = null;
    stubLabels = [];
  });

  it('always submits the stringified value', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} name="volume" value="30"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwSlider;

    await element.updateComplete;

    expect(latestInternals?.values.at(-1)).toBe('30');
    expect(latestInternals?.states.at(-1)).toBe('30');

    element.value = 0;
    await element.updateComplete;

    expect(latestInternals?.values.at(-1)).toBe('0');
  });

  it('publishes its range and orientation through internals', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} min="5" max="25" value="10"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwSlider;

    await element.updateComplete;

    expect(latestInternals?.role).toBe('slider');
    expect(latestInternals?.ariaValueNow).toBe('10');
    expect(latestInternals?.ariaValueMin).toBe('5');
    expect(latestInternals?.ariaValueMax).toBe('25');
    expect(latestInternals?.ariaOrientation).toBe('horizontal');
    expect(latestInternals?.ariaValueText).toBeNull();

    element.valueText = 'Ten of twenty-five';
    await element.updateComplete;

    expect(latestInternals?.ariaValueText).toBe('Ten of twenty-five');
  });

  it('sets no validity flag for a normal configuration, required included', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} required value="30"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwSlider;

    await element.updateComplete;

    expect(Object.values(latestInternals?.flags ?? {}).includes(true)).toBe(false);
  });

  it('reports rangeUnderflow when the configuration contradicts itself', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} min="50" max="10"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwSlider;

    await element.updateComplete;

    expect(latestInternals?.flags.rangeUnderflow).toBe(true);

    element.max = 60;
    await element.updateComplete;

    expect(Object.values(latestInternals?.flags ?? {}).includes(true)).toBe(false);
  });

  it('names itself from associated labels without mutating them', async () => {
    document.body.innerHTML = `<label id="external">Volume</label><${INTERNALS_TAG}></${INTERNALS_TAG}>`;

    const label = document.querySelector<HTMLLabelElement>('#external');
    const element = document.body.querySelector<MndwSlider>(INTERNALS_TAG);

    if (!label || !element) {
      throw new Error('missing label or slider');
    }

    await element.updateComplete;
    expect(latestInternals?.labelledBy).toEqual([]);

    stubLabels = [label];
    element.refreshAccessibleName();
    await element.updateComplete;

    expect(latestInternals?.labelledBy).toEqual([label]);
    expect(element.getAttribute('aria-labelledby')).toBe('external');
    expect(label.getAttribute('id')).toBe('external');
  });
});
