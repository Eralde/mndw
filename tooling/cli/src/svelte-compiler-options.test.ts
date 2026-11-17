import {describe, expect, it} from 'vitest';
import {mndwSvelteWarningFilter} from '@mndw/sdk/svelte';

describe('CLI Svelte compiler configuration', () => {
  it('uses the SDK filter contract for custom-button interaction warnings', () => {
    expect(mndwSvelteWarningFilter({
      code: 'a11y_click_events_have_key_events',
      message: 'Visible, non-interactive element `<mndw-button>` with a click event',
    })).toBe(false);
    expect(mndwSvelteWarningFilter({
      code: 'a11y_no_static_element_interactions',
      message: '`<mndw-button>` with a click handler must have an ARIA role',
    })).toBe(false);
    expect(mndwSvelteWarningFilter({
      code: 'a11y_click_events_have_key_events',
      message: 'Visible, non-interactive element `<div>` with a click event',
    })).toBe(true);
  });
});
