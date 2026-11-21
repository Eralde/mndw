// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {defineComponents, mount as mountComponent, press, settle} from '../testing/index.js';
import {MNDW_RADIO_GROUP_TAG, MndwRadioGroup} from './radio-group.js';
import {MNDW_RADIO_TAG, MndwRadio} from './radio.js';

const THREE_RADIOS = '<mndw-radio value="day">Day</mndw-radio>'
  + '<mndw-radio value="week">Week</mndw-radio>'
  + '<mndw-radio value="month">Month</mndw-radio>';

defineComponents(
  [MNDW_RADIO_GROUP_TAG, MndwRadioGroup],
  [MNDW_RADIO_TAG, MndwRadio],
);

async function mount(inner: string, attributes = ''): Promise<MndwRadioGroup> {
  const element = await mountComponent(
    `<mndw-radio-group ${attributes}>${inner}</mndw-radio-group>`,
    MNDW_RADIO_GROUP_TAG,
  );

  await settle(element);

  return element;
}

function radios(element: MndwRadioGroup): MndwRadio[] {
  return [...element.querySelectorAll<MndwRadio>(MNDW_RADIO_TAG)];
}

function tabStops(element: MndwRadioGroup): (string | null)[] {
  return radios(element).map((radio) => radio.getAttribute('tabindex'));
}

function checkedStates(element: MndwRadioGroup): (string | null)[] {
  return radios(element).map((radio) => radio.getAttribute('aria-checked'));
}

describe('<mndw-radio-group> semantics', () => {
  it('applies the documented defaults', async () => {
    const element = await mount(THREE_RADIOS);

    expect(element.value).toBe('');
    expect(element.label).toBe('');
    expect(element.disabled).toBe(false);
    expect(element.required).toBe(false);
    expect(element.name).toBe('');
    expect(element.getAttribute('size')).toBe('md');
    expect(element.getAttribute('orientation')).toBe('vertical');
  });

  it('reflects size and orientation and maps them to styling', async () => {
    const element = await mount(THREE_RADIOS);

    Reflect.set(element, 'size', 'sm');
    Reflect.set(element, 'orientation', 'horizontal');
    await element.updateComplete;

    expect(element.getAttribute('size')).toBe('sm');
    expect(element.getAttribute('orientation')).toBe('horizontal');

    const cssText = MndwRadioGroup.styles.cssText;

    expect(cssText).toContain(':host([size=\'sm\'])');
    expect(cssText).toContain('--_mndw-radio-indicator-size: 1.125rem');
    expect(cssText).toContain('--_mndw-radio-indicator-size: 1rem');
    expect(cssText).toContain('--_mndw-radio-label-gap: var(--mndw-space-1)');
    expect(cssText).toContain(':host([orientation=\'horizontal\']) [part=\'group\']');
    expect(cssText).toContain('gap: var(--mndw-space-4)');

    Reflect.set(element, 'size', 'compact');
    await element.updateComplete;

    expect(element.getAttribute('size')).toBe('compact');
    expect(cssText).not.toContain(':host([size=\'compact\'])');
  });

  it('carries vertical radiogroup semantics without a host tabindex', async () => {
    const element = await mount(THREE_RADIOS);

    expect(element.getAttribute('role')).toBe('radiogroup');
    expect(element.getAttribute('aria-orientation')).toBe('vertical');
    expect(element.getAttribute('aria-disabled')).toBe('false');
    expect(element.getAttribute('aria-required')).toBe('false');
    expect(element.hasAttribute('tabindex')).toBe(false);
    expect(element.shadowRoot?.querySelector('[part="group"]')).not.toBeNull();
  });

  it('gives every radio the radio role and no selection initially', async () => {
    const element = await mount(THREE_RADIOS);

    expect(radios(element).map((radio) => radio.getAttribute('role'))).toEqual(['radio', 'radio', 'radio']);
    expect(checkedStates(element)).toEqual(['false', 'false', 'false']);
    expect(element.value).toBe('');
  });

  it('puts the tab stop on the first enabled radio when nothing is checked', async () => {
    const element = await mount(THREE_RADIOS);

    expect(tabStops(element)).toEqual(['0', '-1', '-1']);
  });

  it('skips a disabled first radio when placing the tab stop', async () => {
    const element = await mount(
      '<mndw-radio value="day" disabled>Day</mndw-radio><mndw-radio value="week">Week</mndw-radio>',
    );

    expect(tabStops(element)).toEqual(['-1', '0']);
    expect(radios(element)[0].getAttribute('aria-disabled')).toBe('true');
  });

  it('moves the tab stop to the checked radio', async () => {
    const element = await mount(THREE_RADIOS, 'value="week"');

    expect(tabStops(element)).toEqual(['-1', '0', '-1']);
    expect(checkedStates(element)).toEqual(['false', 'true', 'false']);
  });

  it('exposes a non-empty label through the host and removes it again', async () => {
    const element = await mount(THREE_RADIOS, 'label="Interval"');

    expect(element.getAttribute('aria-label')).toBe('Interval');

    element.label = '';
    await element.updateComplete;

    expect(element.hasAttribute('aria-label')).toBe(false);
  });
});

describe('<mndw-radio-group> activation', () => {
  it('selects on click and reports the new value', async () => {
    const element = await mount(THREE_RADIOS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    radios(element)[1].click();
    await element.updateComplete;

    expect(element.value).toBe('week');
    expect(checkedStates(element)).toEqual(['false', 'true', 'false']);
    expect(changes).toHaveBeenCalledTimes(1);
    expect((changes.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'week'});
  });

  it('selects the focused radio with Space but ignores Enter', async () => {
    const element = await mount(THREE_RADIOS);
    const [day, week] = radios(element);

    const space = await press(element, ' ', day);

    expect(element.value).toBe('day');
    expect(space.defaultPrevented).toBe(true);

    const enter = await press(element, 'Enter', week);

    expect(element.value).toBe('day');
    expect(enter.defaultPrevented).toBe(false);
  });

  it('emits nothing for a programmatic value change', async () => {
    const element = await mount(THREE_RADIOS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    element.value = 'month';
    await element.updateComplete;

    expect(changes).not.toHaveBeenCalled();
    expect(checkedStates(element)).toEqual(['false', 'false', 'true']);
  });

  it('cannot be selected through a disabled radio', async () => {
    const element = await mount(
      '<mndw-radio value="day">Day</mndw-radio><mndw-radio value="week" disabled>Week</mndw-radio>',
    );
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    radios(element)[1].click();
    await element.updateComplete;

    expect(element.value).toBe('');
    expect(changes).not.toHaveBeenCalled();
  });

  it('does not select while the group is disabled', async () => {
    const element = await mount(THREE_RADIOS, 'disabled');

    radios(element)[1].click();
    await press(element, 'ArrowRight', radios(element)[0]);

    expect(element.value).toBe('');
    expect(tabStops(element)).toEqual(['-1', '-1', '-1']);
    expect(element.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('<mndw-radio-group> keyboard navigation', () => {
  it('moves focus and selection with all four arrow keys', async () => {
    const element = await mount(THREE_RADIOS, 'value="day"');
    const [day, week] = radios(element);

    const down = await press(element, 'ArrowDown', day);

    expect(element.value).toBe('week');
    expect(document.activeElement).toBe(week);
    expect(down.defaultPrevented).toBe(true);

    await press(element, 'ArrowUp', week);

    expect(element.value).toBe('day');
    expect(document.activeElement).toBe(day);

    await press(element, 'ArrowRight', day);

    expect(element.value).toBe('week');

    await press(element, 'ArrowLeft', week);

    expect(element.value).toBe('day');
  });

  it('wraps forward and backward at both ends', async () => {
    const element = await mount(THREE_RADIOS, 'value="month"');
    const [day, , month] = radios(element);

    await press(element, 'ArrowRight', month);

    expect(element.value).toBe('day');

    await press(element, 'ArrowLeft', day);

    expect(element.value).toBe('month');
  });

  it('skips disabled radios while navigating', async () => {
    const element = await mount(
      '<mndw-radio value="day">Day</mndw-radio>'
        + '<mndw-radio value="week" disabled>Week</mndw-radio>'
        + '<mndw-radio value="month">Month</mndw-radio>',
      'value="day"',
    );

    await press(element, 'ArrowRight', radios(element)[0]);

    expect(element.value).toBe('month');

    await press(element, 'ArrowLeft', radios(element)[2]);

    expect(element.value).toBe('day');
  });
});

describe('<mndw-radio-group> form lifecycle', () => {
  it('restores the value attribute on reset', async () => {
    const element = await mount(THREE_RADIOS, 'value="day"');

    element.value = 'month';
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe('day');
  });

  it('resets to no selection when no value attribute was authored', async () => {
    const element = await mount(THREE_RADIOS);

    element.value = 'month';
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe('');
    expect(checkedStates(element)).toEqual(['false', 'false', 'false']);
  });

  it('restores submitted state', async () => {
    const element = await mount(THREE_RADIOS);

    element.formStateRestoreCallback('week', 'restore');
    await element.updateComplete;

    expect(element.value).toBe('week');
  });
});

interface FakeInternals {
  values: (string | File | FormData | null)[];
  flags: ValidityStateFlags;
  message: string;
  role: string | null;
  ariaLabel: string | null;
  ariaOrientation: string | null;
  anchor: HTMLElement | null;
  reportValidity: () => boolean;
}

const INTERNALS_TAG = 'mndw-radio-group-internals-probe';
let latestInternals: FakeInternals | null = null;

function createFakeInternals(): ElementInternals & {record: FakeInternals} {
  const record: FakeInternals = {
    values: [],
    flags: {},
    message: '',
    role: null,
    ariaLabel: null,
    ariaOrientation: null,
    anchor: null,
    reportValidity: () => {
      record.anchor?.focus();

      return Object.keys(record.flags).length === 0;
    },
  };

  return {
    record,
    setFormValue(value: string | File | FormData | null): void {
      record.values.push(value);
    },
    setValidity(flags: ValidityStateFlags, message = '', anchor?: HTMLElement): void {
      record.flags = flags;
      record.message = message;
      record.anchor = anchor ?? null;
    },
    set role(value: string | null) {
      record.role = value;
    },
    set ariaLabel(value: string | null) {
      record.ariaLabel = value;
    },
    set ariaOrientation(value: string | null) {
      record.ariaOrientation = value;
    },
  } as unknown as ElementInternals & {record: FakeInternals};
}

// happy-dom 17 has no `HTMLElement.prototype.attachInternals`, so the form-value, validity, and
// naming paths are covered against a stub for the duration of this block.
describe('<mndw-radio-group> against ElementInternals', () => {
  let previous: PropertyDescriptor | undefined;

  beforeAll(() => {
    if (!customElements.get(INTERNALS_TAG)) {
      customElements.define(INTERNALS_TAG, class extends MndwRadioGroup {});
    }
  });

  beforeEach(() => {
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
  });

  async function mountProbe(attributes: string): Promise<MndwRadioGroup> {
    document.body.innerHTML = `<${INTERNALS_TAG} ${attributes}>${THREE_RADIOS}</${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwRadioGroup;

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await element.updateComplete;

    return element;
  }

  it('omits an unselected group from FormData and submits the selected value', async () => {
    const element = await mountProbe('name="interval"');

    expect(latestInternals?.values.at(-1)).toBeNull();

    element.value = 'week';
    await element.updateComplete;

    expect(latestInternals?.values.at(-1)).toBe('week');

    element.value = 'year';
    await element.updateComplete;

    expect(latestInternals?.values.at(-1)).toBeNull();
  });

  it('reports valueMissing only while required and unselected', async () => {
    const element = await mountProbe('required');

    expect(latestInternals?.flags.valueMissing).toBe(true);
    expect(latestInternals?.message).toBe('Please select an option.');

    element.value = 'week';
    await element.updateComplete;

    expect(latestInternals?.flags.valueMissing ?? false).toBe(false);

    element.value = '';
    element.required = false;
    await element.updateComplete;

    expect(latestInternals?.flags.valueMissing ?? false).toBe(false);
  });

  it('focuses the first enabled radio when required validation fails', async () => {
    const element = await mountProbe('required');
    const firstEnabled = radios(element)[0];

    if (!firstEnabled) {
      throw new Error('missing first radio');
    }

    expect(latestInternals?.anchor).toBe(firstEnabled);
    expect(latestInternals?.reportValidity()).toBe(false);
    expect(document.activeElement).toBe(firstEnabled);
  });

  it('publishes its role, orientation, and label through internals', async () => {
    const element = await mountProbe('label="Interval" orientation="horizontal"');

    expect(latestInternals?.role).toBe('radiogroup');
    expect(latestInternals?.ariaOrientation).toBe('horizontal');
    expect(latestInternals?.ariaLabel).toBe('Interval');

    element.label = '';
    await element.updateComplete;

    expect(latestInternals?.ariaLabel).toBeNull();
  });
});
