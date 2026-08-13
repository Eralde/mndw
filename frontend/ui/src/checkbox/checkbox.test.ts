import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_LABEL_CHANGE_EVENT} from '../field/field.js';
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
  const found = element.shadowRoot?.querySelector<HTMLElement>('[part="box"]');

  if (!found) {
    throw new Error('missing checkbox box');
  }

  return found;
}

describe('<mndw-checkbox>', () => {
  it('renders unchecked by default', async () => {
    const element = await mount('<mndw-checkbox>Show offline</mndw-checkbox>');

    expect(element.checked).toBe(false);
    expect(element.getAttribute('aria-checked')).toBe('false');
  });

  it('dispatches mndwlabelchange when slotted label text changes', async () => {
    const element = await mount('<mndw-checkbox>Show offline</mndw-checkbox>');
    const listener = vi.fn();

    element.addEventListener(MNDW_LABEL_CHANGE_EVENT, listener);

    const text = element.firstChild;

    if (!text) {
      throw new Error('missing slotted label text');
    }

    text.textContent = 'Show offline devices';
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reflects the checked attribute for external styling', async () => {
    const element = await mount('<mndw-checkbox checked>On</mndw-checkbox>');

    expect(element.checked).toBe(true);
    expect(element.hasAttribute('checked')).toBe(true);
    expect(element.getAttribute('aria-checked')).toBe('true');
  });

  it('reports indeterminate as mixed', async () => {
    const element = await mount('<mndw-checkbox indeterminate>Some</mndw-checkbox>');

    expect(element.getAttribute('aria-checked')).toBe('mixed');
  });

  it('restores checked from its authored attribute and clears indeterminate', async () => {
    const element = await mount('<mndw-checkbox>Some</mndw-checkbox>');

    element.checked = true;
    element.indeterminate = true;
    element.formResetCallback();
    await element.updateComplete;

    expect(element.checked).toBe(false);
    expect(element.indeterminate).toBe(false);
  });

  it('restores checkbox state without changing its value', async () => {
    const element = await mount('<mndw-checkbox value="wifi6">Some</mndw-checkbox>');

    element.formStateRestoreCallback('indeterminate', 'restore');
    await element.updateComplete;

    expect(element.checked).toBe(false);
    expect(element.indeterminate).toBe(true);
    expect(element.value).toBe('wifi6');
  });

  it('exposes box, mark, and label parts', async () => {
    const element = await mount('<mndw-checkbox>Show offline</mndw-checkbox>');

    expect(element.shadowRoot?.querySelector('[part="box"]')).not.toBeNull();
    expect(element.shadowRoot?.querySelector('[part="mark"]')).not.toBeNull();
    expect(element.shadowRoot?.querySelector('slot[part="label"]')).not.toBeNull();
  });

  it('uses only existing mndw token names', () => {
    const cssText = String(MndwCheckbox.styles);

    expect(cssText).toContain('--mndw-text');
    expect(cssText).toContain('--mndw-border');
    expect(cssText).toContain('--mndw-surface');
    expect(cssText).toContain('--mndw-accent');
    expect(cssText).not.toContain('--mndw-color-');
  });

  it('scopes shared typography and focus-ring styles to the checkbox host', () => {
    const cssText = String(MndwCheckbox.styles);

    expect(cssText).toMatch(/:host\s*\{[\s\S]*font-family:/);
    expect(cssText).toMatch(/:host\(:focus-visible\)\s*\{[\s\S]*outline:/);
  });

  it('reveals the mark from the reflected checked attribute, not the box aria-checked', () => {
    const cssText = String(MndwCheckbox.styles);

    // The box is aria-hidden and never carries aria-checked, so the checked visuals
    // must key off the host's reflected attributes or the mark stays hidden.
    expect(cssText).toContain(':host([checked]:not([indeterminate])) [part=\'mark\']');
    expect(cssText).toContain(':host([indeterminate]) [part=\'mark\']');
    expect(cssText).not.toContain('[part=\'box\'][aria-checked');
  });

  it('keeps the mark out of flow and toggles only visibility so the box baseline is stable', () => {
    const cssText = String(MndwCheckbox.styles);

    // Box establishes the containing block for the absolutely positioned mark.
    expect(cssText).toMatch(/\[part='box'\]\s*\{[^}]*position: relative;/);

    // Mark is always block, out of flow, and centered — never display:none, which is
    // the toggle that shifted the box baseline.
    expect(cssText).toMatch(/\[part='mark'\]\s*\{[^}]*position: absolute;/);
    expect(cssText).toMatch(/\[part='mark'\]\s*\{[^}]*display: block;/);
    expect(cssText).toContain('top: 50%');
    expect(cssText).toContain('left: 50%');
    expect(cssText).toContain('translate(-50%, -50%)');
    expect(cssText).not.toContain('display: none');

    // Default hidden, revealed by visibility in checked and indeterminate states.
    expect(cssText).toMatch(/\[part='mark'\]\s*\{[^}]*visibility: hidden;/);
    expect(cssText).toMatch(
      /:host\(\[checked\]:not\(\[indeterminate\]\)\)\s+\[part='mark'\]\s*\{[^}]*visibility: visible;/,
    );
    expect(cssText).toMatch(
      /:host\(\[indeterminate\]\)\s+\[part='mark'\]\s*\{[^}]*visibility: visible;/,
    );

    // Indeterminate keeps its bar dimensions.
    expect(cssText).toMatch(
      /:host\(\[indeterminate\]\)\s+\[part='mark'\]\s*\{[^}]*width: 9px;[^}]*height: 2px;/,
    );
  });

  it('uses pointer cursor for the label and not-allowed when disabled', () => {
    const cssText = String(MndwCheckbox.styles);

    expect(cssText).toContain('[part=\'label\']');
    expect(cssText).toContain('cursor: pointer');
    expect(cssText).toContain(':host([disabled]) [part=\'label\']');
    expect(cssText).toContain('cursor: not-allowed');
  });

  it('toggles on click and emits mndwchange', async () => {
    const element = await mount('<mndw-checkbox>Toggle</mndw-checkbox>');
    const onChange = vi.fn();

    element.addEventListener('mndwchange', onChange);
    box(element).click();
    await element.updateComplete;

    expect(element.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0][0] as CustomEvent<{checked: boolean; indeterminate: boolean}>).detail).toEqual({
      checked: true,
      indeterminate: false,
    });
  });

  it('exposes checkbox semantics on the host and makes its shadow box presentational', async () => {
    const element = await mount('<mndw-checkbox>Toggle</mndw-checkbox>');

    expect(element.getAttribute('role')).toBe('checkbox');
    expect(element.getAttribute('aria-checked')).toBe('false');
    expect(element.getAttribute('tabindex')).toBe('0');
    expect(box(element).getAttribute('role')).toBeNull();
    expect(box(element).getAttribute('tabindex')).toBeNull();
  });

  it('exposes form lifecycle callbacks', async () => {
    const element = await mount('<mndw-checkbox checked>Toggle</mndw-checkbox>');

    expect(typeof element.formResetCallback).toBe('function');
    expect(typeof element.formStateRestoreCallback).toBe('function');
    expect(typeof element.formDisabledCallback).toBe('function');
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

    element.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true}));
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
  const states = new Set<string>();
  let ariaChecked: string | null = null;

  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'attachInternals', {
      configurable: true,
      writable: true,
      value(): ElementInternals {
        return {
          setFormValue,
          states,
          setValidity(): void {},
          get ariaChecked(): string | null {
            return ariaChecked;
          },
          set ariaChecked(value: string | null) {
            ariaChecked = value;
          },
        } as unknown as ElementInternals;
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
    states.clear();
    ariaChecked = null;
  });

  async function mountProbe(html: string): Promise<MndwCheckbox> {
    document.body.innerHTML = html;

    const element = document.body.firstElementChild as MndwCheckbox;

    await element.updateComplete;

    return element;
  }

  it('reports no form value while unchecked', async () => {
    await mountProbe(`<${TAG}></${TAG}>`);

    expect(setFormValue).toHaveBeenCalledWith(null, expect.any(String));
  });

  it('reports the value once checked', async () => {
    const element = await mountProbe(`<${TAG} value="offline"></${TAG}>`);

    setFormValue.mockClear();
    element.checked = true;
    await element.updateComplete;

    expect(setFormValue).toHaveBeenCalledWith('offline', expect.any(String));
  });

  it('defaults the submitted value to "on"', async () => {
    const element = await mountProbe(`<${TAG} checked></${TAG}>`);

    expect(element.value).toBe('on');
    expect(setFormValue).toHaveBeenCalledWith('on', expect.any(String));
  });

  it('clears the form value when unchecked again', async () => {
    const element = await mountProbe(`<${TAG} checked></${TAG}>`);

    setFormValue.mockClear();
    element.checked = false;
    await element.updateComplete;

    expect(setFormValue).toHaveBeenCalledWith(null, expect.any(String));
  });

  it('synchronizes checked state to ElementInternals', async () => {
    const element = await mountProbe(`<${TAG}></${TAG}>`);

    element.checked = true;
    await element.updateComplete;

    expect(ariaChecked).toBe('true');
    expect(states.has('checked')).toBe(true);
  });

  it('reports mixed state without the checked state', async () => {
    await mountProbe(`<${TAG} indeterminate></${TAG}>`);

    expect(ariaChecked).toBe('mixed');
    expect(states.has('checked')).toBe(false);
  });
});
