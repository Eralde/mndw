import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {MNDW_TAB_TAG, MndwTab} from './tab.js';

beforeAll(() => {
  if (!customElements.get(MNDW_TAB_TAG)) {
    customElements.define(MNDW_TAB_TAG, MndwTab);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mount(html: string): Promise<MndwTab> {
  document.body.innerHTML = html;

  const element = document.body.querySelector<MndwTab>(MNDW_TAB_TAG);

  if (!element) {
    throw new Error('missing tab');
  }

  await element.updateComplete;

  return element;
}

describe('<mndw-tab>', () => {
  it('applies the documented defaults', async () => {
    const element = await mount('<mndw-tab id="general">General</mndw-tab>');

    expect(element.disabled).toBe(false);
    expect(element.id).toBe('general');
  });

  it('reflects disabled', async () => {
    const element = await mount('<mndw-tab id="general" disabled>General</mndw-tab>');

    expect(element.disabled).toBe(true);

    element.disabled = false;
    await element.updateComplete;

    expect(element.hasAttribute('disabled')).toBe(false);
  });

  it('exposes the tab part and slots its content', async () => {
    const element = await mount('<mndw-tab id="general">General</mndw-tab>');
    const part = element.shadowRoot?.querySelector('[part="tab"]');

    expect(part).not.toBeNull();
    expect(part?.querySelector('slot')).not.toBeNull();
  });

  it('carries no semantics of its own — the group writes them', async () => {
    const element = await mount('<mndw-tab id="general">General</mndw-tab>');

    expect(element.hasAttribute('role')).toBe(false);
    expect(element.hasAttribute('aria-selected')).toBe(false);
  });

  it('names the right attribute when an author puts for on a tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount('<mndw-tab id="general" for="general-panel">General</mndw-tab>');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('mndw-tab-panel');
  });

  it('says nothing for a well-formed tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount('<mndw-tab id="general">General</mndw-tab>');

    expect(warn).not.toHaveBeenCalled();
  });
});
