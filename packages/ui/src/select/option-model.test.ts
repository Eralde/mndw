import {beforeAll, describe, expect, it, vi} from 'vitest';
import {MNDW_OPTION_TAG, MndwOption} from './option.js';
import {readOptions} from './option-model.js';

beforeAll(() => {
  if (!customElements.get(MNDW_OPTION_TAG)) {
    customElements.define(MNDW_OPTION_TAG, MndwOption);
  }
});

function host(html: string): HTMLElement {
  document.body.innerHTML = `<div>${html}</div>`;

  return document.body.firstElementChild as HTMLElement;
}

describe('readOptions', () => {
  it('returns an empty list when there are no options', () => {
    expect(readOptions(host(''))).toEqual([]);
  });

  it('reads value and trimmed label in document order', () => {
    const root = host(`
      <mndw-option value="isp">  Wired  </mndw-option>
      <mndw-option value="wifi">Wireless</mndw-option>
    `);

    expect(readOptions(root)).toEqual([
      {value: 'isp', label: 'Wired', disabled: false},
      {value: 'wifi', label: 'Wireless', disabled: false},
    ]);
  });

  it('collapses interior whitespace produced by template interpolation', () => {
    const root = host('<mndw-option value="a">Kitchen TV\n   (offline)</mndw-option>');

    expect(readOptions(root)[0].label).toBe('Kitchen TV (offline)');
  });

  it('falls back to the value when there is no text', () => {
    const root = host('<mndw-option value="eth0"></mndw-option>');

    expect(readOptions(root)[0].label).toBe('eth0');
  });

  it('treats a missing value attribute as the empty string', () => {
    const root = host('<mndw-option>None</mndw-option>');

    expect(readOptions(root)[0].value).toBe('');
  });

  it('marks disabled options', () => {
    const root = host('<mndw-option value="a" disabled>A</mndw-option>');

    expect(readOptions(root)[0].disabled).toBe(true);
  });

  it('ignores non-option children', () => {
    const root = host('<span>noise</span><mndw-option value="a">A</mndw-option>');

    expect(readOptions(root)).toHaveLength(1);
  });
});

describe('<mndw-option>', () => {
  it('exposes value and disabled as properties', () => {
    const root = host('<mndw-option value="a" disabled>A</mndw-option>');
    const option = root.firstElementChild as MndwOption;

    expect(option.value).toBe('a');
    expect(option.disabled).toBe(true);
  });

  it('is not rendered — it carries no shadow root', () => {
    const root = host('<mndw-option value="a">A</mndw-option>');

    expect((root.firstElementChild as MndwOption).shadowRoot).toBeNull();
  });
});

describe('<mndw-option> mutation reporting', () => {
  it('announces a value change', () => {
    const root = host('<mndw-option value="a">A</mndw-option>');
    const option = root.firstElementChild as MndwOption;
    const onChange = vi.fn();

    root.addEventListener('mndwoptionchange', onChange);
    option.value = 'b';

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('announces a disabled change', () => {
    const root = host('<mndw-option value="a">A</mndw-option>');
    const option = root.firstElementChild as MndwOption;
    const onChange = vi.fn();

    root.addEventListener('mndwoptionchange', onChange);
    option.disabled = true;

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('announces a text change', async () => {
    const root = host('<mndw-option value="a">A</mndw-option>');
    const option = root.firstElementChild as MndwOption;
    const onChange = vi.fn();

    root.addEventListener('mndwoptionchange', onChange);
    option.textContent = 'Renamed';
    await Promise.resolve();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not announce when the value is set to its current value', () => {
    const root = host('<mndw-option value="a">A</mndw-option>');
    const option = root.firstElementChild as MndwOption;
    const onChange = vi.fn();

    root.addEventListener('mndwoptionchange', onChange);
    option.value = 'a';

    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the event out of the light DOM of unrelated ancestors', () => {
    const root = host('<mndw-option value="a">A</mndw-option>');
    const option = root.firstElementChild as MndwOption;
    let composed = true;

    root.addEventListener('mndwoptionchange', (event) => {
      composed = event.composed;
    });
    option.value = 'b';

    expect(composed).toBe(false);
  });
});
