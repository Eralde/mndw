import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_FIELD_TAG, MndwField} from '../field/field.js';
import {MNDW_INPUT_TAG, MndwInput} from './input.js';

beforeAll(() => {
  if (!customElements.get(MNDW_INPUT_TAG)) {
    customElements.define(MNDW_INPUT_TAG, MndwInput);
  }

  if (!customElements.get(MNDW_FIELD_TAG)) {
    customElements.define(MNDW_FIELD_TAG, MndwField);
  }
});

async function mount(html: string): Promise<MndwInput> {
  document.body.innerHTML = html;

  const element = document.body.querySelector<MndwInput>(MNDW_INPUT_TAG);

  if (!element) {
    throw new Error('missing input');
  }

  await element.updateComplete;

  return element;
}

async function settle(element: MndwInput): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await element.updateComplete;
}

function inner(element: MndwInput): HTMLInputElement {
  const found = element.shadowRoot?.querySelector<HTMLInputElement>('input');

  if (!found) {
    throw new Error('missing inner input');
  }

  return found;
}

async function type(element: MndwInput, text: string): Promise<void> {
  const control = inner(element);

  control.value = text;
  control.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
  await element.updateComplete;
}

function focusInner(element: MndwInput): void {
  inner(element).dispatchEvent(new Event('focus'));
}

function blurInner(element: MndwInput): void {
  inner(element).dispatchEvent(new Event('blur'));
}

function pressEnter(element: MndwInput): void {
  inner(element).dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
}

describe('<mndw-input> properties', () => {
  it('applies the documented defaults', async () => {
    const element = await mount('<mndw-input></mndw-input>');

    expect(element.value).toBe('');
    expect(element.type).toBe('text');
    expect(element.placeholder).toBe('');
    expect(element.autocomplete).toBe('');
    expect(element.readonly).toBe(false);
    expect(element.required).toBe(false);
    expect(element.disabled).toBe(false);
    expect(element.invalid).toBe(false);
    expect(element.name).toBe('');
    expect(element.min).toBeNull();
    expect(element.max).toBeNull();
    expect(element.step).toBeNull();
    expect(element.maxlength).toBeNull();
  });

  it('renders one native input with the documented parts and slots', async () => {
    const element = await mount('<mndw-input></mndw-input>');
    const root = element.shadowRoot;

    expect(root?.querySelectorAll('input')).toHaveLength(1);
    expect(root?.querySelector('[part="field"]')).not.toBeNull();
    expect(inner(element).getAttribute('part')).toBe('input');
    expect(root?.querySelector('slot[name="prefix"]')?.getAttribute('part')).toBe('prefix');
    expect(root?.querySelector('slot[name="suffix"]')?.getAttribute('part')).toBe('suffix');
  });

  it('forwards every supported type and falls back to text for others', async () => {
    for (const supported of ['text', 'password', 'search', 'number', 'url']) {
      const element = await mount(`<mndw-input type="${supported}"></mndw-input>`);

      expect(inner(element).getAttribute('type')).toBe(supported);
    }

    const unsupported = await mount('<mndw-input type="email"></mndw-input>');

    expect(unsupported.type).toBe('email');
    expect(inner(unsupported).getAttribute('type')).toBe('text');
  });

  it('forwards presentation and constraint attributes to the inner input', async () => {
    const element = await mount(
      '<mndw-input type="number" placeholder="Port" autocomplete="off" readonly min="1" max="65535" step="2"'
        + ' maxlength="5"></mndw-input>',
    );
    const control = inner(element);

    expect(control.getAttribute('placeholder')).toBe('Port');
    expect(control.getAttribute('autocomplete')).toBe('off');
    expect(control.hasAttribute('readonly')).toBe(true);
    expect(control.getAttribute('min')).toBe('1');
    expect(control.getAttribute('max')).toBe('65535');
    expect(control.getAttribute('step')).toBe('2');
    expect(control.getAttribute('maxlength')).toBe('5');
  });

  it('never writes an empty optional attribute to the inner input', async () => {
    const element = await mount('<mndw-input></mndw-input>');
    const control = inner(element);

    for (const attribute of ['placeholder', 'autocomplete', 'min', 'max', 'step', 'maxlength', 'aria-label']) {
      expect(control.hasAttribute(attribute), attribute).toBe(false);
    }
  });

  it('keeps value as state: it does not reflect and the attribute stays the authored default', async () => {
    const element = await mount('<mndw-input value="first"></mndw-input>');

    expect(element.value).toBe('first');
    expect(inner(element).value).toBe('first');

    element.value = 'second';
    await element.updateComplete;

    expect(element.getAttribute('value')).toBe('first');
    expect(inner(element).value).toBe('second');
  });
});

describe('<mndw-input> events', () => {
  it('emits mndwinput for every native input event with the updated value', async () => {
    const element = await mount('<mndw-input></mndw-input>');
    const seen: string[] = [];

    element.addEventListener('mndwinput', (event) => {
      seen.push((event as CustomEvent<{value: string}>).detail.value);
      expect((event.target as MndwInput).value).toBe(seen[seen.length - 1]);
    });

    focusInner(element);
    await type(element, 'a');
    await type(element, 'ab');

    expect(seen).toEqual(['a', 'ab']);
    expect(element.value).toBe('ab');
  });

  it('commits on blur only when the value changed since focus', async () => {
    const element = await mount('<mndw-input></mndw-input>');
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);

    focusInner(element);
    blurInner(element);

    expect(changes).not.toHaveBeenCalled();

    focusInner(element);
    await type(element, 'wan0');
    blurInner(element);

    expect(changes).toHaveBeenCalledTimes(1);
    expect((changes.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'wan0'});
  });

  it('commits on Enter and does not repeat the commit on the following blur', async () => {
    const element = await mount('<mndw-input></mndw-input>');
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);

    focusInner(element);
    await type(element, 'wan0');
    pressEnter(element);

    expect(changes).toHaveBeenCalledTimes(1);

    blurInner(element);

    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('emits nothing for a programmatic write and does not commit it on blur', async () => {
    const element = await mount('<mndw-input></mndw-input>');
    const events = vi.fn();

    element.addEventListener('mndwinput', events);
    element.addEventListener('mndwchange', events);

    focusInner(element);
    element.value = 'from-binding';
    await element.updateComplete;

    expect(events).not.toHaveBeenCalled();

    blurInner(element);

    expect(events).not.toHaveBeenCalled();
    expect(inner(element).value).toBe('from-binding');
  });

  it('still commits user editing that follows a programmatic write', async () => {
    const element = await mount('<mndw-input></mndw-input>');
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);

    focusInner(element);
    element.value = 'from-binding';
    await element.updateComplete;
    await type(element, 'from-binding!');
    blurInner(element);

    expect(changes).toHaveBeenCalledTimes(1);
    expect((changes.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'from-binding!'});
  });
});

describe('<mndw-input> form participation', () => {
  it('resets to the authored value attribute', async () => {
    const element = await mount('<mndw-input value="default"></mndw-input>');

    element.value = 'typed';
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe('default');
    expect(inner(element).value).toBe('default');
  });

  it('restores submitted state', async () => {
    const element = await mount('<mndw-input></mndw-input>');

    element.formStateRestoreCallback('restored', 'restore');
    await element.updateComplete;

    expect(element.value).toBe('restored');
  });

  it('mirrors effective disabled from an ancestor fieldset onto the inner input', async () => {
    const element = await mount('<mndw-input></mndw-input>');

    element.formDisabledCallback(true);
    await element.updateComplete;

    expect(inner(element).disabled).toBe(true);

    element.formDisabledCallback(false);
    await element.updateComplete;

    expect(inner(element).disabled).toBe(false);
  });

  it('mirrors required from the property and from host aria-required', async () => {
    const element = await mount('<mndw-input required></mndw-input>');

    expect(inner(element).hasAttribute('required')).toBe(true);

    element.required = false;
    await element.updateComplete;

    expect(inner(element).hasAttribute('required')).toBe(false);

    element.setAttribute('aria-required', 'true');
    await settle(element);

    expect(inner(element).hasAttribute('required')).toBe(true);
  });
});

// happy-dom 17 has no `HTMLElement.prototype.attachInternals`, so the form-value, validity, and
// computed-invalid paths are covered against a stub for the duration of this block.
interface FakeInternals {
  values: (string | File | FormData | null)[];
  flags: ValidityStateFlags;
  message: string;
  validity: {valid: boolean};
}

const INTERNALS_TAG = 'mndw-input-internals-probe';
let latestInternals: FakeInternals | null = null;

function createFakeInternals(): ElementInternals & {record: FakeInternals} {
  const record: FakeInternals = {values: [], flags: {}, message: '', validity: {valid: true}};

  return {
    record,
    setFormValue(value: string | File | FormData | null): void {
      record.values.push(value);
    },
    setValidity(flags: ValidityStateFlags, message = ''): void {
      record.flags = flags;
      record.message = message;
      record.validity.valid = !Object.values(flags).includes(true);
    },
    get validity(): {valid: boolean} {
      return record.validity;
    },
  } as unknown as ElementInternals & {record: FakeInternals};
}

async function mountProbe(attributes: string): Promise<MndwInput> {
  document.body.innerHTML = `<${INTERNALS_TAG} ${attributes}></${INTERNALS_TAG}>`;

  const element = document.body.firstElementChild as MndwInput;

  await element.updateComplete;

  return element;
}

describe('<mndw-input> against ElementInternals', () => {
  let previous: PropertyDescriptor | undefined;

  beforeAll(() => {
    if (!customElements.get(INTERNALS_TAG)) {
      customElements.define(INTERNALS_TAG, class extends MndwInput {});
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

  it('submits its value, including the empty string, and never names the inner input', async () => {
    const element = await mountProbe('name="host"');

    expect(latestInternals?.values).toEqual(['']);
    expect(inner(element).hasAttribute('name')).toBe(false);

    element.value = 'router';
    await element.updateComplete;

    expect(latestInternals?.values.at(-1)).toBe('router');
  });

  it('mirrors the inner element‘s constraint validity onto the host', async () => {
    const element = await mountProbe('required');

    expect(latestInternals?.flags.valueMissing).toBe(true);
    expect(latestInternals?.validity.valid).toBe(false);

    element.value = 'set';
    await element.updateComplete;

    expect(latestInternals?.flags.valueMissing).toBe(false);
    expect(latestInternals?.validity.valid).toBe(true);
  });

  it('mirrors range constraints the inner element computes', async () => {
    const element = await mountProbe('type="number" min="10"');

    element.value = '5';
    await element.updateComplete;

    expect(latestInternals?.flags.rangeUnderflow).toBe(true);
    expect(latestInternals?.validity.valid).toBe(false);
  });

  it('announces computed invalidity on the inner element', async () => {
    const element = await mountProbe('required');

    expect(inner(element).getAttribute('aria-invalid')).toBe('true');

    element.value = 'set';
    await element.updateComplete;

    expect(inner(element).hasAttribute('aria-invalid')).toBe(false);
  });

  it('lets a host aria-invalid attribute override computed validity', async () => {
    const element = await mountProbe('required');

    element.setAttribute('aria-invalid', 'false');
    await settle(element);

    expect(inner(element).hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('<mndw-input> accessible name and description forwarding', () => {
  it('forwards a host aria-label to the inner input', async () => {
    const element = await mount('<mndw-input aria-label="Host name"></mndw-input>');

    expect(inner(element).getAttribute('aria-label')).toBe('Host name');
  });

  it('prefers host aria-labelledby over aria-label and resolves it to text', async () => {
    const element = await mount(
      '<span id="naming">Interface  name</span><mndw-input aria-labelledby="naming" aria-label="Ignored"></mndw-input>',
    );

    expect(inner(element).getAttribute('aria-label')).toBe('Interface name');
  });

  it('forwards the text of an associated label', async () => {
    const element = await mount('<label for="named">Host name</label><mndw-input id="named"></mndw-input>');

    expect(inner(element).getAttribute('aria-label')).toBe('Host name');
  });

  it('re-resolves when a host naming attribute changes', async () => {
    const element = await mount('<mndw-input aria-label="First"></mndw-input>');

    element.setAttribute('aria-label', 'Second');
    await settle(element);

    expect(inner(element).getAttribute('aria-label')).toBe('Second');

    element.removeAttribute('aria-label');
    await settle(element);

    expect(inner(element).hasAttribute('aria-label')).toBe(false);
  });

  it('re-resolves when the text of a referenced node is edited in place', async () => {
    const element = await mount('<span id="naming">Before</span><mndw-input aria-labelledby="naming"></mndw-input>');
    const target = document.getElementById('naming');

    if (!target) {
      throw new Error('missing naming node');
    }

    target.textContent = 'After';
    await settle(element);

    expect(inner(element).getAttribute('aria-label')).toBe('After');
  });

  it('re-resolves on demand through refreshAccessibleName', async () => {
    const element = await mount('<label for="named">First</label><mndw-input id="named"></mndw-input>');
    const label = document.querySelector('label');

    if (!label) {
      throw new Error('missing label');
    }

    label.remove();
    element.refreshAccessibleName();
    await element.updateComplete;

    expect(inner(element).hasAttribute('aria-label')).toBe(false);
  });

  it('forwards the resolved description text', async () => {
    const element = await mount(
      '<span id="hint">Shown in the device list</span><mndw-input aria-describedby="hint"></mndw-input>',
    );

    expect(inner(element).getAttribute('aria-description')).toBe('Shown in the device list');

    element.removeAttribute('aria-describedby');
    await settle(element);

    expect(inner(element).hasAttribute('aria-description')).toBe(false);
  });
});

describe('<mndw-input> invalid announcement', () => {
  it('lets the host aria-invalid attribute outrank the invalid property', async () => {
    const element = await mount('<mndw-input></mndw-input>');

    element.invalid = true;
    await element.updateComplete;

    expect(inner(element).getAttribute('aria-invalid')).toBe('true');

    element.setAttribute('aria-invalid', 'false');
    await settle(element);

    expect(inner(element).hasAttribute('aria-invalid')).toBe(false);

    element.setAttribute('aria-invalid', 'true');
    await settle(element);

    expect(inner(element).getAttribute('aria-invalid')).toBe('true');
  });

  it('announces the invalid property when no attribute is present', async () => {
    const element = await mount('<mndw-input></mndw-input>');

    expect(inner(element).hasAttribute('aria-invalid')).toBe(false);

    element.invalid = true;
    await element.updateComplete;

    expect(inner(element).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('<mndw-input> inside <mndw-field>', () => {
  it.each([
    ['optional', ''],
    ['required', 'required'],
  ])('forwards the %s field label without its marker text', async (_case, flag) => {
    document.body.innerHTML = `<mndw-field label="Router name" ${flag}><mndw-input></mndw-input></mndw-field>`;

    const element = document.body.querySelector<MndwInput>(MNDW_INPUT_TAG);

    if (!element) {
      throw new Error('missing input');
    }

    await settle(element);

    expect(inner(element).getAttribute('aria-label')).toBe('Router name');
  });

  it('takes its name, description, and invalid state from the field', async () => {
    document.body.innerHTML = '<mndw-field label="Host name" hint="Shown in the device list" error="Already in use">'
      + '<mndw-input></mndw-input></mndw-field>';

    const field = document.body.querySelector<MndwField>(MNDW_FIELD_TAG);
    const element = document.body.querySelector<MndwInput>(MNDW_INPUT_TAG);

    if (!field || !element) {
      throw new Error('missing field or input');
    }

    await settle(element);

    const control = inner(element);

    expect(control.getAttribute('aria-label')).toContain('Host name');
    expect(control.getAttribute('aria-description')).toBe('Shown in the device list Already in use');
    expect(control.getAttribute('aria-invalid')).toBe('true');

    field.error = '';
    await settle(element);

    expect(control.hasAttribute('aria-invalid')).toBe(false);
    expect(control.getAttribute('aria-description')).toBe('Shown in the device list');
  });
});
