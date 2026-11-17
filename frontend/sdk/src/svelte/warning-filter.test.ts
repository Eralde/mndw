import {describe, expect, it} from 'vitest';
import {mndwSvelteWarningFilter} from './warning-filter.js';

describe('mndwSvelteWarningFilter', () => {
  it('suppresses only the two custom-button interaction false positives', () => {
    expect(mndwSvelteWarningFilter({
      code: 'a11y_click_events_have_key_events',
      message: 'Visible, non-interactive element `<mndw-button>` with a click event',
    })).toBe(false);
    expect(mndwSvelteWarningFilter({
      code: 'a11y_no_static_element_interactions',
      message: '`<mndw-button>` with a click handler must have an ARIA role',
    })).toBe(false);
  });

  it('keeps warnings for other elements and warning codes', () => {
    expect(mndwSvelteWarningFilter({
      code: 'a11y_click_events_have_key_events',
      message: 'Visible, non-interactive element `<div>` with a click event',
    })).toBe(true);
    expect(mndwSvelteWarningFilter({
      code: 'a11y_consider_explicit_label',
      message: 'Buttons and links should have a label: `<mndw-button>`',
    })).toBe(true);
  });
});
