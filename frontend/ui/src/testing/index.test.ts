import {MNDW_TABLE_TAG} from '../table/table.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getMndwUiLocale, setMndwUiLocale} from '../index.js';
import {type UiOverlayProvider, getOverlayProvider, setOverlayProvider} from '../overlay.js';
import {defineMndwTestComponents, resetUiTestState} from './index.js';

afterEach(() => {
  setMndwUiLocale('en');
});

describe('ui test scaffolding', () => {
  it('defineMndwTestComponents registers the mndw custom elements (idempotent)', () => {
    defineMndwTestComponents();
    defineMndwTestComponents();
    expect(customElements.get(MNDW_TABLE_TAG)).toBeTypeOf('function');
  });

  it('resetUiTestState restores locale and overlay state and clears the body', () => {
    const provider = {open: vi.fn()} as unknown as UiOverlayProvider;

    setOverlayProvider(provider);
    setMndwUiLocale('ru');
    document.body.innerHTML = '<p>x</p>';
    resetUiTestState();
    expect(getMndwUiLocale()).toBe('en');
    expect(getOverlayProvider()).not.toBe(provider);
    expect(document.body.innerHTML).toBe('');
  });
});
