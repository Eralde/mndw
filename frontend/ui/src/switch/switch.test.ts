import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_FIELD_TAG, MndwField} from '../field/field.js';
import {defineComponents, mount, press, settle} from '../testing/index.js';
import {MNDW_SWITCH_TAG, MndwSwitch} from './switch.js';

defineComponents(
  [MNDW_SWITCH_TAG, MndwSwitch],
  [MNDW_FIELD_TAG, MndwField],
);

describe('<mndw-switch> semantics', () => {
  it('applies the documented defaults', async () => {
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);

    expect(element.checked).toBe(false);
    expect(element.value).toBe('on');
    expect(element.disabled).toBe(false);
    expect(element.required).toBe(false);
    expect(element.invalid).toBe(false);
    expect(element.name).toBe('');
  });

  it('carries switch semantics and the tab stop on the host', async () => {
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);

    expect(element.getAttribute('role')).toBe('switch');
    expect(element.getAttribute('aria-checked')).toBe('false');
    expect(element.getAttribute('aria-disabled')).toBe('false');
    expect(element.tabIndex).toBe(0);
  });

  it('reflects checked and announces it', async () => {
    const element = await mount('<mndw-switch checked></mndw-switch>', MNDW_SWITCH_TAG);

    expect(element.checked).toBe(true);
    expect(element.getAttribute('aria-checked')).toBe('true');

    element.checked = false;
    await element.updateComplete;

    expect(element.hasAttribute('checked')).toBe(false);
    expect(element.getAttribute('aria-checked')).toBe('false');
  });

  it('reflects value as configuration', async () => {
    const element = await mount('<mndw-switch value="dark"></mndw-switch>', MNDW_SWITCH_TAG);

    expect(element.value).toBe('dark');

    element.value = 'light';
    await element.updateComplete;

    expect(element.getAttribute('value')).toBe('light');
  });

  it('exposes track, thumb, and label parts', async () => {
    const element = await mount('<mndw-switch>Dark theme</mndw-switch>', MNDW_SWITCH_TAG);
    const root = element.shadowRoot;

    expect(root?.querySelector('[part="track"]')).not.toBeNull();
    expect(root?.querySelector('[part="thumb"]')).not.toBeNull();
    expect(root?.querySelector('slot[part="label"]')).not.toBeNull();
  });

  it('keeps no interactive descendant inside the shadow root', async () => {
    const element = await mount('<mndw-switch>Dark theme</mndw-switch>', MNDW_SWITCH_TAG);
    const root = element.shadowRoot;

    expect(root?.querySelector('button, input, a, [tabindex]')).toBeNull();
    expect(root?.querySelector('[part="track"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.querySelector('[part="track"]')?.hasAttribute('role')).toBe(false);
  });
});

describe('<mndw-switch> interaction', () => {
  it('toggles on click and reports the new state', async () => {
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    element.click();
    await element.updateComplete;

    expect(element.checked).toBe(true);
    expect(element.getAttribute('aria-checked')).toBe('true');
    expect(changes).toHaveBeenCalledTimes(1);
    expect((changes.mock.calls[0][0] as CustomEvent<{checked: boolean}>).detail).toEqual({checked: true});

    element.click();
    await element.updateComplete;

    expect(element.checked).toBe(false);
    expect((changes.mock.calls[1][0] as CustomEvent<{checked: boolean}>).detail).toEqual({checked: false});
  });

  it('toggles on Space and Enter and consumes the keystroke', async () => {
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);

    const space = await press(element, ' ');

    expect(element.checked).toBe(true);
    expect(space.defaultPrevented).toBe(true);

    const enter = await press(element, 'Enter');

    expect(element.checked).toBe(false);
    expect(enter.defaultPrevented).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('ignores other keys', async () => {
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);

    await press(element, 'a');

    expect(element.checked).toBe(false);
  });

  it('does not toggle while disabled and leaves the tab order', async () => {
    const element = await mount('<mndw-switch disabled></mndw-switch>', MNDW_SWITCH_TAG);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    element.click();
    await press(element, ' ');

    expect(element.checked).toBe(false);
    expect(changes).not.toHaveBeenCalled();
    expect(element.getAttribute('aria-disabled')).toBe('true');
    expect(element.tabIndex).toBe(-1);
  });

  it('does not toggle while an ancestor fieldset is disabled', async () => {
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);

    element.formDisabledCallback(true);
    await element.updateComplete;

    element.click();
    await element.updateComplete;

    expect(element.checked).toBe(false);
    expect(element.getAttribute('aria-disabled')).toBe('true');

    element.formDisabledCallback(false);
    await element.updateComplete;

    element.click();
    await element.updateComplete;

    expect(element.checked).toBe(true);
  });

  it('emits nothing for a programmatic change', async () => {
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);
    element.checked = true;
    await element.updateComplete;

    expect(changes).not.toHaveBeenCalled();
  });
});

describe('<mndw-switch> form lifecycle', () => {
  it('restores the checked attribute on reset', async () => {
    const element = await mount('<mndw-switch checked></mndw-switch>', MNDW_SWITCH_TAG);

    element.checked = false;
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.checked).toBe(true);
  });

  it('restores submitted state', async () => {
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);

    element.formStateRestoreCallback('checked', 'restore');
    await element.updateComplete;

    expect(element.checked).toBe(true);

    element.formStateRestoreCallback('unchecked', 'restore');
    await element.updateComplete;

    expect(element.checked).toBe(false);
  });

  it('accepts required without announcing or enforcing it', async () => {
    const element = await mount('<mndw-switch required></mndw-switch>', MNDW_SWITCH_TAG);

    expect(element.required).toBe(true);
    expect(element.hasAttribute('aria-required')).toBe(false);
  });
});

describe('<mndw-switch> inside <mndw-field>', () => {
  it('is labelled by the field, since a switch has no label source of its own', async () => {
    document.body.innerHTML = '<mndw-field label="Dark theme"><mndw-switch>Dark theme</mndw-switch></mndw-field>';

    const field = document.body.querySelector<MndwField>(MNDW_FIELD_TAG);
    const element = document.body.querySelector<MndwSwitch>(MNDW_SWITCH_TAG);

    if (!field || !element) {
      throw new Error('missing field or switch');
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
  ariaChecked: string | null;
  labelledBy: Element[];
  customStates: Set<string>;
}

const INTERNALS_TAG = 'mndw-switch-internals-probe';
let latestInternals: FakeInternals | null = null;
let stubLabels: HTMLLabelElement[] = [];

function createFakeInternals(): ElementInternals & {record: FakeInternals} {
  const record: FakeInternals = {
    values: [],
    states: [],
    flags: {},
    role: null,
    ariaChecked: null,
    labelledBy: [],
    customStates: new Set<string>(),
  };

  return {
    record,
    states: record.customStates,
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
    set ariaChecked(value: string | null) {
      record.ariaChecked = value;
    },
    set ariaLabelledByElements(value: Element[]) {
      record.labelledBy = value;
    },
  } as unknown as ElementInternals & {record: FakeInternals};
}

// happy-dom 17 has no `HTMLElement.prototype.attachInternals`, so the form-value, role, and label
// paths are covered against a stub for the duration of this block.
describe('<mndw-switch> against ElementInternals', () => {
  let previous: PropertyDescriptor | undefined;

  beforeAll(() => {
    if (!customElements.get(INTERNALS_TAG)) {
      customElements.define(INTERNALS_TAG, class extends MndwSwitch {});
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

  it('submits its value only while checked, with the state the browser hands back', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} name="theme" value="dark"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwSwitch;

    await element.updateComplete;

    expect(latestInternals?.values.at(-1)).toBeNull();
    expect(latestInternals?.states.at(-1)).toBe('unchecked');

    element.checked = true;
    await element.updateComplete;

    expect(latestInternals?.values.at(-1)).toBe('dark');
    expect(latestInternals?.states.at(-1)).toBe('checked');
  });

  it('publishes its role and checked state through internals', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} checked></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwSwitch;

    await element.updateComplete;

    expect(latestInternals?.role).toBe('switch');
    expect(latestInternals?.ariaChecked).toBe('true');
    expect(latestInternals?.customStates.has('checked')).toBe(true);
  });

  it('never sets a validity flag, even when required', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} required></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwSwitch;

    await element.updateComplete;

    expect(Object.values(latestInternals?.flags ?? {}).includes(true)).toBe(false);
  });

  it('names itself from associated labels without mutating them', async () => {
    document.body.innerHTML = `<label id="external">Dark theme</label><${INTERNALS_TAG}></${INTERNALS_TAG}>`;

    const label = document.querySelector<HTMLLabelElement>('#external');
    const element = document.body.querySelector<MndwSwitch>(INTERNALS_TAG);

    if (!label || !element) {
      throw new Error('missing label or switch');
    }

    stubLabels = [label];
    element.requestUpdate();
    await element.updateComplete;

    expect(latestInternals?.labelledBy).toEqual([label]);
    expect(label.getAttribute('id')).toBe('external');
  });

  it('refreshes its name when an associated label is added after the initial update', async () => {
    document.body.innerHTML = `<label id="external">Dark theme</label><${INTERNALS_TAG}></${INTERNALS_TAG}>`;

    const label = document.querySelector<HTMLLabelElement>('#external');
    const element = document.body.querySelector<MndwSwitch>(INTERNALS_TAG);

    if (!label || !element) {
      throw new Error('missing label or switch');
    }

    await element.updateComplete;
    expect(latestInternals?.labelledBy).toEqual([]);

    stubLabels = [label];
    element.refreshAccessibleName();
    await element.updateComplete;

    expect(latestInternals?.labelledBy).toEqual([label]);
    expect(element.getAttribute('aria-labelledby')).toBe('external');
  });
});
