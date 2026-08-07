import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_FIELD_TAG, MndwField} from '../field/field.js';
import {MNDW_TEXTAREA_TAG, MndwTextarea} from './textarea.js';

beforeAll(() => {
  if (!customElements.get(MNDW_TEXTAREA_TAG)) {
    customElements.define(MNDW_TEXTAREA_TAG, MndwTextarea);
  }

  if (!customElements.get(MNDW_FIELD_TAG)) {
    customElements.define(MNDW_FIELD_TAG, MndwField);
  }
});

async function mount(html: string): Promise<MndwTextarea> {
  document.body.innerHTML = html;

  const element = document.body.querySelector<MndwTextarea>(MNDW_TEXTAREA_TAG);

  if (!element) {
    throw new Error('missing textarea');
  }

  await element.updateComplete;

  return element;
}

async function settle(element: MndwTextarea): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await element.updateComplete;
}

function inner(element: MndwTextarea): HTMLTextAreaElement {
  const found = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');

  if (!found) {
    throw new Error('missing inner textarea');
  }

  return found;
}

async function type(element: MndwTextarea, text: string): Promise<void> {
  const control = inner(element);

  control.value = text;
  control.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
  await element.updateComplete;
}

function focusInner(element: MndwTextarea): void {
  inner(element).dispatchEvent(new Event('focus'));
}

function blurInner(element: MndwTextarea): void {
  inner(element).dispatchEvent(new Event('blur'));
}

function pressEnter(element: MndwTextarea): void {
  inner(element).dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
}

describe('<mndw-textarea> properties', () => {
  it('applies the documented defaults', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');

    expect(element.value).toBe('');
    expect(element.rows).toBe(3);
    expect(element.autosize).toBe(false);
    expect(element.readonly).toBe(false);
    expect(element.required).toBe(false);
    expect(element.disabled).toBe(false);
    expect(element.invalid).toBe(false);
    expect(element.name).toBe('');
    expect(element.maxlength).toBeNull();
  });

  it('renders one native textarea with the documented parts', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');
    const root = element.shadowRoot;

    expect(root?.querySelectorAll('textarea')).toHaveLength(1);
    expect(root?.querySelector('[part="field"]')).not.toBeNull();
    expect(inner(element).getAttribute('part')).toBe('textarea');
  });

  it('sizes the inner textarea from rows', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');

    expect(inner(element).getAttribute('rows')).toBe('3');

    element.rows = 8;
    await element.updateComplete;

    expect(inner(element).getAttribute('rows')).toBe('8');
  });

  it('forwards maxlength and omits it when unset', async () => {
    const element = await mount('<mndw-textarea maxlength="120"></mndw-textarea>');

    expect(inner(element).getAttribute('maxlength')).toBe('120');

    element.maxlength = null;
    await element.updateComplete;

    expect(inner(element).hasAttribute('maxlength')).toBe(false);
  });

  it('mirrors readonly onto the inner textarea', async () => {
    const element = await mount('<mndw-textarea readonly></mndw-textarea>');

    expect(inner(element).hasAttribute('readonly')).toBe(true);

    element.readonly = false;
    await element.updateComplete;

    expect(inner(element).hasAttribute('readonly')).toBe(false);
  });

  it('keeps value as state: it does not reflect and the attribute stays the authored default', async () => {
    const element = await mount('<mndw-textarea value="first"></mndw-textarea>');

    expect(element.value).toBe('first');
    expect(inner(element).value).toBe('first');

    element.value = 'second';
    await element.updateComplete;

    expect(element.getAttribute('value')).toBe('first');
    expect(inner(element).value).toBe('second');
  });
});

describe('<mndw-textarea> autosize', () => {
  it('keeps rows and adds no inline height while autosize is off', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');

    expect(inner(element).getAttribute('rows')).toBe('3');
    expect(inner(element).style.height).toBe('');
  });

  it('drops rows and drives height from content when opted in', async () => {
    const element = await mount('<mndw-textarea autosize></mndw-textarea>');

    expect(inner(element).hasAttribute('rows')).toBe(false);
    expect(inner(element).style.height).not.toBe('');
  });

  it('restores rows sizing when autosize is turned back off', async () => {
    const element = await mount('<mndw-textarea autosize rows="4"></mndw-textarea>');

    element.autosize = false;
    await element.updateComplete;

    expect(inner(element).getAttribute('rows')).toBe('4');
    expect(inner(element).style.height).toBe('');
  });
});

describe('<mndw-textarea> events', () => {
  it('emits mndwinput for every native input event with the updated value', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');
    const seen: string[] = [];

    element.addEventListener('mndwinput', (event: Event) => {
      seen.push((event as CustomEvent<{value: string}>).detail.value);
    });

    focusInner(element);
    await type(element, 'a');
    await type(element, 'ab');

    expect(seen).toEqual(['a', 'ab']);
    expect(element.value).toBe('ab');
  });

  it('keeps newlines and does not commit on Enter', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);

    focusInner(element);
    await type(element, 'first\nsecond');
    pressEnter(element);

    expect(element.value).toBe('first\nsecond');
    expect(changes).not.toHaveBeenCalled();

    blurInner(element);

    expect(changes).toHaveBeenCalledTimes(1);
    expect((changes.mock.calls[0][0] as CustomEvent<{value: string}>).detail).toEqual({value: 'first\nsecond'});
  });

  it('commits on blur only when the value changed since focus', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');
    const changes = vi.fn();

    element.addEventListener('mndwchange', changes);

    focusInner(element);
    blurInner(element);

    expect(changes).not.toHaveBeenCalled();
  });

  it('emits nothing for a programmatic write and does not commit it on blur', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');
    const events = vi.fn();

    element.addEventListener('mndwinput', events);
    element.addEventListener('mndwchange', events);

    focusInner(element);
    element.value = 'from-binding';
    await element.updateComplete;
    blurInner(element);

    expect(events).not.toHaveBeenCalled();
    expect(inner(element).value).toBe('from-binding');
  });
});

describe('<mndw-textarea> form participation', () => {
  it('resets to the authored value attribute', async () => {
    const element = await mount('<mndw-textarea value="default"></mndw-textarea>');

    element.value = 'typed';
    await element.updateComplete;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.value).toBe('default');
    expect(inner(element).value).toBe('default');
  });

  it('restores submitted state', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');

    element.formStateRestoreCallback('restored', 'restore');
    await element.updateComplete;

    expect(element.value).toBe('restored');
  });

  it('mirrors effective disabled from an ancestor fieldset onto the inner textarea', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');

    element.formDisabledCallback(true);
    await element.updateComplete;

    expect(inner(element).disabled).toBe(true);

    element.formDisabledCallback(false);
    await element.updateComplete;

    expect(inner(element).disabled).toBe(false);
  });

  it('mirrors required from the property and from host aria-required', async () => {
    const element = await mount('<mndw-textarea required></mndw-textarea>');

    expect(inner(element).hasAttribute('required')).toBe(true);

    element.required = false;
    await element.updateComplete;

    expect(inner(element).hasAttribute('required')).toBe(false);

    element.setAttribute('aria-required', 'true');
    await settle(element);

    expect(inner(element).hasAttribute('required')).toBe(true);
  });
});

describe('<mndw-textarea> accessible name and description forwarding', () => {
  it('forwards a host aria-label to the inner textarea', async () => {
    const element = await mount('<mndw-textarea aria-label="Release notes"></mndw-textarea>');

    expect(inner(element).getAttribute('aria-label')).toBe('Release notes');
  });

  it('forwards the text of an associated label', async () => {
    const element = await mount('<label for="named">Release notes</label><mndw-textarea id="named"></mndw-textarea>');

    expect(inner(element).getAttribute('aria-label')).toBe('Release notes');
  });

  it('forwards the resolved description text and clears it again', async () => {
    const element = await mount(
      '<span id="hint">Markdown is supported</span><mndw-textarea aria-describedby="hint"></mndw-textarea>',
    );

    expect(inner(element).getAttribute('aria-description')).toBe('Markdown is supported');

    element.removeAttribute('aria-describedby');
    await settle(element);

    expect(inner(element).hasAttribute('aria-description')).toBe(false);
  });

  it('re-resolves on demand through refreshAccessibleName', async () => {
    const element = await mount('<label for="named">Release notes</label><mndw-textarea id="named"></mndw-textarea>');

    document.querySelector('label')?.remove();
    element.refreshAccessibleName();
    await element.updateComplete;

    expect(inner(element).hasAttribute('aria-label')).toBe(false);
  });

  it('announces the invalid property on the inner textarea', async () => {
    const element = await mount('<mndw-textarea></mndw-textarea>');

    expect(inner(element).hasAttribute('aria-invalid')).toBe(false);

    element.invalid = true;
    await element.updateComplete;

    expect(inner(element).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('<mndw-textarea> inside <mndw-field>', () => {
  it.each([
    ['optional', ''],
    ['required', 'required'],
  ])('takes its %s field label, description, and invalid state', async (_case, flag) => {
    document.body.innerHTML = `<mndw-field label="Release notes" hint="Markdown is supported" error="Too long" ${flag}>`
      + '<mndw-textarea></mndw-textarea></mndw-field>';

    const element = document.body.querySelector<MndwTextarea>(MNDW_TEXTAREA_TAG);

    if (!element) {
      throw new Error('missing textarea');
    }

    await settle(element);

    const control = inner(element);

    expect(control.getAttribute('aria-label')).toContain('Release notes');
    expect(control.getAttribute('aria-label')).not.toContain('*');
    expect(control.getAttribute('aria-description')).toBe('Markdown is supported Too long');
    expect(control.getAttribute('aria-invalid')).toBe('true');
  });
});

interface FakeInternals {
  values: (string | File | FormData | null)[];
  flags: ValidityStateFlags;
  message: string;
  validity: {valid: boolean};
}

const INTERNALS_TAG = 'mndw-textarea-internals-probe';
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

// happy-dom 17 has no `HTMLElement.prototype.attachInternals`, so the form-value and validity paths
// are covered against a stub for the duration of this block.
describe('<mndw-textarea> against ElementInternals', () => {
  let previous: PropertyDescriptor | undefined;

  beforeAll(() => {
    if (!customElements.get(INTERNALS_TAG)) {
      customElements.define(INTERNALS_TAG, class extends MndwTextarea {});
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

  it('submits its value, including the empty string, under the host name', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} name="notes"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwTextarea;

    await element.updateComplete;

    expect(latestInternals?.values).toEqual(['']);
    expect(inner(element).hasAttribute('name')).toBe(false);

    element.value = 'released';
    await element.updateComplete;

    expect(latestInternals?.values.at(-1)).toBe('released');
  });

  it('mirrors the inner element‘s constraint validity onto the host', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} required></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwTextarea;

    await element.updateComplete;

    expect(latestInternals?.flags.valueMissing).toBe(true);
    expect(inner(element).getAttribute('aria-invalid')).toBe('true');

    element.value = 'set';
    await element.updateComplete;

    expect(latestInternals?.flags.valueMissing).toBe(false);
    expect(inner(element).hasAttribute('aria-invalid')).toBe(false);
  });
});
