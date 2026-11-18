// @vitest-environment happy-dom

import {describe, expect, it, vi} from 'vitest';

import {createInstance} from './index.js';
import {makeStubContext} from './test-helpers.js';

describe('generated frontend', () => {
  it('calls hello and renders the typed message after a button click', async () => {
    const call = vi.fn().mockResolvedValue({message: 'hello'});
    const container = document.createElement('div');
    const instance = createInstance(container, makeStubContext({backend: {call}}));

    container.querySelector('mndw-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith('hello', {as: 'json'});
      expect(container.querySelector('[data-testid="l10n-result"]')?.textContent).toBe('l10n.result: hello');
    });

    instance.unmount();
  });

  it('renders a localized error when the backend request fails', async () => {
    const call = vi.fn().mockRejectedValue(new Error('unavailable'));
    const container = document.createElement('div');
    const instance = createInstance(container, makeStubContext({backend: {call}}));

    container.querySelector('mndw-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="l10n-result"]')?.textContent).toBe('l10n.error');
    });

    instance.unmount();
  });

  it('renders the fallback when the fixture has no backend declaration', async () => {
    const container = document.createElement('div');
    const instance = createInstance(container, makeStubContext({backend: undefined}));

    expect(container.querySelector('[data-testid="l10n-result"]')?.textContent).toBe('l10n.result');
    container.querySelector('mndw-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="l10n-result"]')?.textContent).toBe('l10n.error');
    });
    instance.unmount();
  });
});
