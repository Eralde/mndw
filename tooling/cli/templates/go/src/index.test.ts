// @vitest-environment happy-dom

import {describe, expect, it, vi} from 'vitest';

import {createInstance} from './index.js';
import {makeStubContext} from './test-helpers.js';

describe('generated frontend', () => {
  it('fetches \'hello\' and renders the typed message', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({message: 'hello', plugin: 'p'})));
    const container = document.createElement('div');
    const instance = createInstance(container, makeStubContext({backend: {fetch}}));

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('hello');
      expect(container.querySelector('[data-testid="l10n-result"]')?.textContent).toBe('l10n.result: hello');
    });

    instance.unmount();
  });

  it('requests hello again when the button is clicked', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({message: 'hello', plugin: 'p'})));
    const container = document.createElement('div');
    const instance = createInstance(container, makeStubContext({backend: {fetch}}));

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    (container.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    instance.unmount();
  });

  it('renders a localized error when the backend request fails', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('unavailable'));
    const container = document.createElement('div');
    const instance = createInstance(container, makeStubContext({backend: {fetch}}));

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="l10n-result"]')?.textContent).toBe('l10n.error');
    });

    instance.unmount();
  });

  it('renders the fallback when backend is undefined without throwing', () => {
    const container = document.createElement('div');
    const instance = createInstance(container, makeStubContext({backend: undefined}));

    expect(container.querySelector('[data-testid="l10n-result"]')?.textContent).toBe('l10n.result');
    instance.unmount();
  });
});
