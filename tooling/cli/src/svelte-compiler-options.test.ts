import {describe, expect, it} from 'vitest';
import {isMndwButtonA11yWarning} from '../../../build/svelte-compiler-options.js';

describe('isMndwButtonA11yWarning', () => {
  it('matches the two Svelte a11y warnings for mndw-button', () => {
    expect(isMndwButtonA11yWarning({
      code: 'a11y_click_events_have_key_events',
      message: 'Visible, non-interactive element `<mndw-button>` with a click event',
    })).toBe(true);
    expect(isMndwButtonA11yWarning({
      code: 'a11y_no_static_element_interactions',
      message: '`<mndw-button>` with a click handler must have an ARIA role',
    })).toBe(true);
  });

  it('does not match other elements or warning codes', () => {
    expect(isMndwButtonA11yWarning({
      code: 'a11y_click_events_have_key_events',
      message: 'Visible, non-interactive element `<div>` with a click event',
    })).toBe(false);
    expect(isMndwButtonA11yWarning({
      code: 'a11y_consider_explicit_label',
      message: 'Buttons and links should have a label: `<mndw-button>`',
    })).toBe(false);
  });
});
