// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_FIELD_TAG, MndwField} from '../field/field.js';
import {defineComponents, mount as mountComponent, press, settle} from '../testing/index.js';
import {MNDW_SEGMENT_TAG, MndwSegment} from './segment.js';
import {MNDW_SEGMENTED_TAG, MndwSegmented} from './segmented.js';

const THREE_SEGMENTS = '<mndw-segment value="day">Day</mndw-segment>'
  + '<mndw-segment value="week">Week</mndw-segment>'
  + '<mndw-segment value="month">Month</mndw-segment>';

defineComponents(
  [MNDW_SEGMENT_TAG, MndwSegment],
  [MNDW_SEGMENTED_TAG, MndwSegmented],
  [MNDW_FIELD_TAG, MndwField],
);

async function mount(inner: string, attributes = ''): Promise<MndwSegmented> {
  const element = await mountComponent(
    `<mndw-segmented ${attributes}>${inner}</mndw-segmented>`,
    MNDW_SEGMENTED_TAG,
  );

  await settle(element);

  return element;
}

function segments(element: MndwSegmented): MndwSegment[] {
  return [...element.querySelectorAll<MndwSegment>(MNDW_SEGMENT_TAG)];
}

function tabStops(element: MndwSegmented): (string | null)[] {
  return segments(element).map((segment) => segment.getAttribute('tabindex'));
}

function checkedStates(element: MndwSegmented): (string | null)[] {
  return segments(element).map((segment) => segment.getAttribute('aria-checked'));
}

describe('<mndw-segmented> semantics', () => {
  it('applies the documented defaults', async () => {
    const element = await mount(THREE_SEGMENTS);

    expect(element.value).toBe('');
    expect(element.label).toBe('');
    expect(element.disabled).toBe(false);
    expect(element.required).toBe(false);
    expect(element.invalid).toBe(false);
    expect(element.name).toBe('');
  });

  it('carries horizontal radiogroup semantics without a host tabindex', async () => {
    const element = await mount(THREE_SEGMENTS);

    expect(element.getAttribute('role')).toBe('radiogroup');
    expect(element.getAttribute('aria-orientation')).toBe('horizontal');
    expect(element.getAttribute('aria-disabled')).toBe('false');
    expect(element.hasAttribute('tabindex')).toBe(false);
    expect(element.shadowRoot?.querySelector('[part="group"]')).not.toBeNull();
  });

  it('gives every segment the radio role and no selection initially', async () => {
    const element = await mount(THREE_SEGMENTS);

    expect(segments(element).map((segment) => segment.getAttribute('role'))).toEqual(['radio', 'radio', 'radio']);
    expect(checkedStates(element)).toEqual(['false', 'false', 'false']);
    expect(element.value).toBe('');
  });

  it('puts the tab stop on the first enabled segment when nothing is checked', async () => {
    const element = await mount(THREE_SEGMENTS);

    expect(tabStops(element)).toEqual(['0', '-1', '-1']);
  });

  it('skips a disabled first segment when placing the tab stop', async () => {
    const element = await mount(
      '<mndw-segment value="day" disabled>Day</mndw-segment><mndw-segment value="week">Week</mndw-segment>',
    );

    expect(tabStops(element)).toEqual(['-1', '0']);
    expect(segments(element)[0].getAttribute('aria-disabled')).toBe('true');
  });

  it('moves the tab stop to the checked segment', async () => {
    const element = await mount(THREE_SEGMENTS, 'value="week"');

    expect(tabStops(element)).toEqual(['-1', '0', '-1']);
    expect(checkedStates(element)).toEqual(['false', 'true', 'false']);
  });

  it('checks nothing when the value matches no segment', async () => {
    const element = await mount(THREE_SEGMENTS, 'value="year"');

    expect(checkedStates(element)).toEqual(['false', 'false', 'false']);
    expect(tabStops(element)).toEqual(['0', '-1', '-1']);
  });

  it('ignores a segment that declares no value', async () => {
    const element = await mount('<mndw-segment>Nothing</mndw-segment><mndw-segment value="week">Week</mndw-segment>');

    expect(segments(element)[0].hasAttribute('role')).toBe(false);
    expect(segments(element)[0].hasAttribute('tabindex')).toBe(false);
    expect(tabStops(element)).toEqual([null, '0']);
  });
});

describe('<mndw-segmented> activation', () => {
  it('selects on click and reports the new value', async () => {
    const element = await mount(THREE_SEGMENTS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    segments(element)[1].click();
    await element.updateComplete;

    expect(element.value).toBe('week');
    expect(checkedStates(element)).toEqual(['false', 'true', 'false']);
    expect(changes).toHaveBeenCalledTimes(1);
    expect((changes.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'week'});
  });

  it('does not re-emit when the already selected segment is activated again', async () => {
    const element = await mount(THREE_SEGMENTS, 'value="week"');
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    segments(element)[1].click();
    await element.updateComplete;

    expect(changes).not.toHaveBeenCalled();
  });

  it('cannot be activated through a disabled segment', async () => {
    const element = await mount(
      '<mndw-segment value="day">Day</mndw-segment><mndw-segment value="week" disabled>Week</mndw-segment>',
    );
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    segments(element)[1].click();
    await element.updateComplete;

    expect(element.value).toBe('');
    expect(changes).not.toHaveBeenCalled();
  });

  it('selects with Space but ignores Enter', async () => {
    const element = await mount(THREE_SEGMENTS);
    const [, week, month] = segments(element);

    await press(element, 'ArrowRight', segments(element)[0]);

    expect(element.value).toBe('week');

    await press(element, ' ', week);

    expect(element.value).toBe('week');

    const enter = await press(element, 'Enter', month);

    expect(element.value).toBe('week');
    expect(enter.defaultPrevented).toBe(false);
  });

  it('emits nothing for a programmatic value change', async () => {
    const element = await mount(THREE_SEGMENTS);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    element.value = 'month';
    await element.updateComplete;

    expect(changes).not.toHaveBeenCalled();
    expect(checkedStates(element)).toEqual(['false', 'false', 'true']);
  });

  it('does not activate while the group is disabled', async () => {
    const element = await mount(THREE_SEGMENTS, 'disabled');

    segments(element)[1].click();
    await press(element, 'ArrowRight', segments(element)[0]);

    expect(element.value).toBe('');
    expect(tabStops(element)).toEqual(['-1', '-1', '-1']);
    expect(element.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('<mndw-segmented> keyboard navigation', () => {
  it('wraps forward and backward with the arrow keys', async () => {
    const element = await mount(THREE_SEGMENTS, 'value="month"');
    const [day, , month] = segments(element);

    const forward = await press(element, 'ArrowRight', month);

    expect(element.value).toBe('day');
    expect(forward.defaultPrevented).toBe(true);

    await press(element, 'ArrowLeft', day);

    expect(element.value).toBe('month');
  });

  it('moves focus and selection with ArrowDown and ArrowUp', async () => {
    const element = await mount(THREE_SEGMENTS, 'value="day"');
    const [day, week] = segments(element);

    const down = await press(element, 'ArrowDown', day);

    expect(element.value).toBe('week');
    expect(document.activeElement).toBe(week);
    expect(down.defaultPrevented).toBe(true);

    const up = await press(element, 'ArrowUp', week);

    expect(element.value).toBe('day');
    expect(document.activeElement).toBe(day);
    expect(up.defaultPrevented).toBe(true);
  });

  it('skips disabled segments while navigating', async () => {
    const element = await mount(
      '<mndw-segment value="day">Day</mndw-segment>'
        + '<mndw-segment value="week" disabled>Week</mndw-segment>'
        + '<mndw-segment value="month">Month</mndw-segment>',
      'value="day"',
    );

    await press(element, 'ArrowRight', segments(element)[0]);

    expect(element.value).toBe('month');
  });

  it('moves to the first and last enabled segment with Home and End', async () => {
    const element = await mount(
      '<mndw-segment value="day" disabled>Day</mndw-segment>'
        + '<mndw-segment value="week">Week</mndw-segment>'
        + '<mndw-segment value="month">Month</mndw-segment>',
      'value="month"',
    );

    const home = await press(element, 'Home', segments(element)[2]);

    expect(element.value).toBe('week');
    expect(home.defaultPrevented).toBe(true);

    const end = await press(element, 'End', segments(element)[1]);

    expect(element.value).toBe('month');
    expect(end.defaultPrevented).toBe(true);
  });

  it('ignores keys it does not own', async () => {
    const element = await mount(THREE_SEGMENTS);
    const event = await press(element, 'a', segments(element)[0]);

    expect(element.value).toBe('');
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('<mndw-segmented> relationships', () => {
  it('rewires when a segment is added', async () => {
    const element = await mount('<mndw-segment value="day">Day</mndw-segment>');
    const added = document.createElement(MNDW_SEGMENT_TAG);

    added.setAttribute('value', 'week');
    element.appendChild(added);
    await settle(element);

    expect(added.getAttribute('role')).toBe('radio');
    expect(tabStops(element)).toEqual(['0', '-1']);
  });

  it('clears the attributes it wrote onto a segment that leaves the group', async () => {
    const element = await mount(THREE_SEGMENTS, 'value="week"');
    const removed = segments(element)[1];

    removed.remove();
    await settle(element);

    expect(removed.hasAttribute('role')).toBe(false);
    expect(removed.hasAttribute('aria-checked')).toBe(false);
    expect(removed.hasAttribute('tabindex')).toBe(false);
    expect(element.value).toBe('week');
    expect(checkedStates(element)).toEqual(['false', 'false']);
  });

  it('clears its relationships when the group is disconnected', async () => {
    const element = await mount(THREE_SEGMENTS);
    const [day] = segments(element);

    element.remove();
    await settle(element);

    expect(day.hasAttribute('role')).toBe(false);
    expect(day.hasAttribute('tabindex')).toBe(false);
  });

  it('rewires when a segment changes its value or disabled state', async () => {
    const element = await mount(THREE_SEGMENTS, 'value="week"');

    segments(element)[1].disabled = true;
    await settle(element);

    expect(segments(element)[1].getAttribute('aria-disabled')).toBe('true');
    expect(tabStops(element)).toEqual(['0', '-1', '-1']);
  });
});

describe('<mndw-segmented> label', () => {
  it('exposes a non-empty label through the host for browser accessibility trees', async () => {
    const element = await mount(THREE_SEGMENTS, 'label="Range"');

    expect(element.getAttribute('aria-label')).toBe('Range');

    element.label = '';
    await element.updateComplete;

    expect(element.hasAttribute('aria-label')).toBe(false);
  });

  it('announces a label change so a wrapping field can rewire', async () => {
    const element = await mount(THREE_SEGMENTS, 'label="Range"');
    const announced = vi.fn();

    element.addEventListener('mndwlabelchange', announced);

    expect(element.label).toBe('Range');
    expect(announced).not.toHaveBeenCalled();

    element.label = 'Period';
    await element.updateComplete;

    expect(announced).toHaveBeenCalledTimes(1);
  });

  it('lets its own label suppress the field label, and defers when empty', async () => {
    document.body.innerHTML = `<mndw-field label="Range"><mndw-segmented label="Range">${THREE_SEGMENTS}`
      + '</mndw-segmented></mndw-field>';

    const field = document.body.querySelector<MndwField>(MNDW_FIELD_TAG);
    const element = document.body.querySelector<MndwSegmented>(MNDW_SEGMENTED_TAG);

    if (!field || !element) {
      throw new Error('missing field or segmented');
    }

    await settle(element);

    const label = field.querySelector<HTMLLabelElement>('label.mndw-field__label');

    expect(label?.hidden).toBe(true);

    element.label = '';
    await settle(element);

    expect(label?.hidden).toBe(false);
  });
});

describe('<mndw-segmented> form lifecycle', () => {
  it('restores the value attribute on reset', async () => {
    const element = await mount(THREE_SEGMENTS, 'value="day"');

    element.value = 'month';
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe('day');
  });

  it('resets to no selection when no value attribute was authored', async () => {
    const element = await mount(THREE_SEGMENTS);

    element.value = 'month';
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe('');
    expect(checkedStates(element)).toEqual(['false', 'false', 'false']);
  });

  it('restores submitted state', async () => {
    const element = await mount(THREE_SEGMENTS);

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
  anchor: HTMLElement | null;
  reportValidity: () => boolean;
}

const INTERNALS_TAG = 'mndw-segmented-internals-probe';
let latestInternals: FakeInternals | null = null;

function createFakeInternals(): ElementInternals & {record: FakeInternals} {
  const record: FakeInternals = {
    values: [],
    flags: {},
    message: '',
    role: null,
    ariaLabel: null,
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
  } as unknown as ElementInternals & {record: FakeInternals};
}

// happy-dom 17 has no `HTMLElement.prototype.attachInternals`, so the form-value, validity, and
// naming paths are covered against a stub for the duration of this block.
describe('<mndw-segmented> against ElementInternals', () => {
  let previous: PropertyDescriptor | undefined;

  beforeAll(() => {
    if (!customElements.get(INTERNALS_TAG)) {
      customElements.define(INTERNALS_TAG, class extends MndwSegmented {});
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

  async function mountProbe(attributes: string): Promise<MndwSegmented> {
    document.body.innerHTML = `<${INTERNALS_TAG} ${attributes}>${THREE_SEGMENTS}</${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwSegmented;

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await element.updateComplete;

    return element;
  }

  it('omits an unselected group from FormData and submits the selected value', async () => {
    const element = await mountProbe('name="range"');

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

    element.value = 'week';
    await element.updateComplete;

    expect(latestInternals?.flags.valueMissing ?? false).toBe(false);

    element.value = '';
    element.required = false;
    await element.updateComplete;

    expect(latestInternals?.flags.valueMissing ?? false).toBe(false);
  });

  it('focuses the first enabled segment when required validation fails', async () => {
    const element = await mountProbe(
      'required',
    );
    const firstEnabled = segments(element)[0];

    if (!firstEnabled) {
      throw new Error('missing first segment');
    }

    expect(latestInternals?.anchor).toBe(firstEnabled);
    expect(latestInternals?.reportValidity()).toBe(false);
    expect(document.activeElement).toBe(firstEnabled);
  });

  it('publishes its role and author-facing label through internals', async () => {
    const element = await mountProbe('label="Range"');

    expect(latestInternals?.role).toBe('radiogroup');
    expect(latestInternals?.ariaLabel).toBe('Range');

    element.label = '';
    await element.updateComplete;

    expect(latestInternals?.ariaLabel).toBeNull();
  });
});
