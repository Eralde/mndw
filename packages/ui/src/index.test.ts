import type {OverlayService} from '@mndw/sdk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  MNDW_BUTTON_TAG,
  MNDW_CHECKBOX_TAG,
  MNDW_OPTION_TAG,
  MNDW_SCROLL_AREA_TAG,
  MNDW_SELECT_PANEL_TAG,
  MNDW_SELECT_TAG,
  defineMndwUi,
} from './index.js';
import {getOverlayProvider, setOverlayProvider} from './overlay.js';

afterEach(() => {
  setOverlayProvider(undefined);
});

describe('defineMndwUi', () => {
  it('registers every element', () => {
    defineMndwUi();

    for (
      const tag of [
        MNDW_BUTTON_TAG,
        MNDW_CHECKBOX_TAG,
        MNDW_OPTION_TAG,
        MNDW_SCROLL_AREA_TAG,
        MNDW_SELECT_PANEL_TAG,
        MNDW_SELECT_TAG,
      ]
    ) {
      expect(customElements.get(tag)).toBeDefined();
    }
  });

  it('is idempotent — the registry is page-global and cannot be redefined', () => {
    defineMndwUi();

    expect(() => defineMndwUi()).not.toThrow();
  });

  it('keeps an injected overlay when called again without one', () => {
    const service = {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as OverlayService;

    defineMndwUi({overlay: service});

    const injected = getOverlayProvider();

    defineMndwUi();

    expect(getOverlayProvider()).toBe(injected);
  });

  it('replaces the provider when a new overlay is supplied', () => {
    const first = {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as OverlayService;
    const second = {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as OverlayService;

    defineMndwUi({overlay: first});

    const before = getOverlayProvider();

    defineMndwUi({overlay: second});

    expect(getOverlayProvider()).not.toBe(before);
  });
});
