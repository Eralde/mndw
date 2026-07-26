import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_CHECKBOX_TAG, MndwCheckbox} from './checkbox.js';

beforeAll(() => {
  if (!customElements.get(MNDW_CHECKBOX_TAG)) {
    customElements.define(MNDW_CHECKBOX_TAG, MndwCheckbox);
  }
});

async function mount(html: string): Promise<MndwCheckbox> {
  document.body.innerHTML = html;

  const element = document.body.firstElementChild as MndwCheckbox;

  await element.updateComplete;

  return element;
}

function box(element: MndwCheckbox): HTMLElement {
  const found = element.shadowRoot?.querySelector<HTMLElement>('[role="checkbox"]');

  if (!found) {
    throw new Error('missing role=checkbox');
  }

  return found;
}

describe('<mndw-checkbox>', () => {
  it('renders unchecked by default', async () => {
    const element = await mount('<mndw-checkbox>Show offline</mndw-checkbox>');

    expect(element.checked).toBe(false);
    expect(box(element).getAttribute('aria-checked')).toBe('false');
  });

  it('reflects the checked attribute for external styling', async () => {
    const element = await mount('<mndw-checkbox checked>On</mndw-checkbox>');

    expect(element.checked).toBe(true);
    expect(element.hasAttribute('checked')).toBe(true);
    expect(box(element).getAttribute('aria-checked')).toBe('true');
  });

  it('reports indeterminate as mixed', async () => {
    const element = await mount('<mndw-checkbox indeterminate>Some</mndw-checkbox>');

    expect(box(element).getAttribute('aria-checked')).toBe('mixed');
  });

  it('toggles on click and emits mndwchange', async () => {
    const element = await mount('<mndw-checkbox>Toggle</mndw-checkbox>');
    const onChange = vi.fn();

    element.addEventListener('mndwchange', onChange);
    box(element).click();
    await element.updateComplete;

    expect(element.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0][0] as CustomEvent<{checked: boolean}>).detail).toEqual({
      checked: true,
    });
  });

  it('emits a composed event that escapes the shadow root', async () => {
    const element = await mount('<mndw-checkbox>Toggle</mndw-checkbox>');
    const onChange = vi.fn();

    document.body.addEventListener('mndwchange', onChange);
    box(element).click();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('toggles on Space and clears indeterminate', async () => {
    const element = await mount('<mndw-checkbox indeterminate>Some</mndw-checkbox>');

    box(element).dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true}));
    await element.updateComplete;

    expect(element.checked).toBe(true);
    expect(element.indeterminate).toBe(false);
  });

  it('ignores interaction when disabled', async () => {
    const element = await mount('<mndw-checkbox disabled>Off</mndw-checkbox>');
    const onChange = vi.fn();

    element.addEventListener('mndwchange', onChange);
    box(element).click();
    await element.updateComplete;

    expect(element.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is form-associated', () => {
    expect(MndwCheckbox.formAssociated).toBe(true);
  });

  it('reflects name to the attribute so form submission finds it', async () => {
    const element = await mount('<mndw-checkbox>Toggle</mndw-checkbox>');

    element.name = 'show-offline';
    await element.updateComplete;

    expect(element.getAttribute('name')).toBe('show-offline');
  });

  it('survives an environment with no attachInternals', async () => {
    // happy-dom 17 has no HTMLElement.prototype.attachInternals; this asserts the guard
    // rather than a shim, so the code path under test is the one that ships.
    const element = await mount('<mndw-checkbox>Toggle</mndw-checkbox>');

    expect(() => box(element).click()).not.toThrow();
  });
});

// The guarded branch above is what happy-dom exercises by default, which means the branch
// real browsers take would otherwise ship untested. These install a minimal ElementInternals
// for the duration of the block so the `internals` path is covered too.
describe('<mndw-checkbox> with ElementInternals available', () => {
  const TAG = 'mndw-checkbox-internals-probe';
  const setFormValue = vi.fn();

  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'attachInternals', {
      configurable: true,
      writable: true,
      value(): ElementInternals {
        return {setFormValue} as unknown as ElementInternals;
      },
    });

    // A second registration under a fresh tag: the class captures `internals` in its
    // constructor, and the original tag's constructor already ran without the stub.
    if (!customElements.get(TAG)) {
      customElements.define(TAG, class extends MndwCheckbox {});
    }
  });

  afterAll(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'attachInternals');
  });

  beforeEach(() => {
    setFormValue.mockClear();
  });

  async function mountProbe(html: string): Promise<MndwCheckbox> {
    document.body.innerHTML = html;

    const element = document.body.firstElementChild as MndwCheckbox;

    await element.updateComplete;

    return element;
  }

  it('reports no form value while unchecked', async () => {
    await mountProbe(`<${TAG}></${TAG}>`);

    expect(setFormValue).toHaveBeenCalledWith(null);
  });

  it('reports the value once checked', async () => {
    const element = await mountProbe(`<${TAG} value="offline"></${TAG}>`);

    setFormValue.mockClear();
    element.checked = true;
    await element.updateComplete;

    expect(setFormValue).toHaveBeenCalledWith('offline');
  });

  it('defaults the submitted value to "on"', async () => {
    const element = await mountProbe(`<${TAG} checked></${TAG}>`);

    expect(element.value).toBe('on');
    expect(setFormValue).toHaveBeenCalledWith('on');
  });

  it('clears the form value when unchecked again', async () => {
    const element = await mountProbe(`<${TAG} checked></${TAG}>`);

    setFormValue.mockClear();
    element.checked = false;
    await element.updateComplete;

    expect(setFormValue).toHaveBeenCalledWith(null);
  });
});
