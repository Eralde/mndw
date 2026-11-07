import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {isMndwButtonA11yWarning as isRepoMndwButtonA11yWarning} from '../../../build/svelte-compiler-options.js';
import {MNDW_BUTTON_A11Y_WARNING_CODES, isMndwButtonA11yWarning} from './svelte-warning-filter.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const repoFilterSource = readFileSync(resolve(repoRoot, 'build/svelte-compiler-options.js'), 'utf8');
const repoCodesSource = repoFilterSource.match(
  /const IGNORED_MNDW_BUTTON_WARNING_CODES = new Set\(\[([\s\S]*?)\]\);/,
)?.[1] ?? '';
const repoWarningCodes = [...repoCodesSource.matchAll(/'([^']+)'/g)].map((match) => match[1]);

describe('CLI Svelte warning filter', () => {
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

  it('rejects other elements and warning codes', () => {
    expect(isMndwButtonA11yWarning({
      code: 'a11y_click_events_have_key_events',
      message: 'Visible, non-interactive element `<div>` with a click event',
    })).toBe(false);
    expect(isMndwButtonA11yWarning({
      code: 'a11y_consider_explicit_label',
      message: 'Buttons and links should have a label: `<mndw-button>`',
    })).toBe(false);
  });

  it('stays in parity with the repository compiler filter and warning-code set', () => {
    expect(repoWarningCodes).toEqual([...MNDW_BUTTON_A11Y_WARNING_CODES]);

    for (const code of [...repoWarningCodes, 'a11y_consider_explicit_label']) {
      for (const message of ['<mndw-button> interaction', '<div> interaction']) {
        const warning = {code, message};

        expect(isMndwButtonA11yWarning(warning)).toBe(isRepoMndwButtonA11yWarning(warning));
      }
    }
  });
});
