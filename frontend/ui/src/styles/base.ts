import {type CSSResult, css} from 'lit';

/**
 * Focus indicator shared by every control. Palette generator validates focus ring against
 * `--mndw-surface-raised` at 3:1.
 */
export const focusRing: CSSResult = css`
  outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);
  outline-offset: 0.0625rem;
`;

/**
 * Metrics every control shares, so a select and a button line up when adjacent.
 *
 * Typography is `inherit`, NOT a token — deliberately. The token default belongs on `:host`
 * (see `hostTypography`), because a declaration on the inner element wins over anything a
 * consumer sets on the custom element, and there would then be no way to resize a control
 * from outside without reaching through `::part()`. Icon buttons need exactly that: the
 * existing `.gear-btn` rules set `font-size: 1.125rem` on the element.
 */
export const controlBase: CSSResult = css`
  box-sizing: border-box;
  min-height: var(--mndw-control-h);
  padding: 0 var(--mndw-space-3);
  border-radius: var(--mndw-radius-md);
  font-family: inherit;
  font-size: inherit;
  line-height: var(--mndw-leading);
`;

/**
 * Token defaults, applied to `:host` so a consumer's `font-size` on the element overrides
 * them through normal inheritance.
 */
export const hostTypography: CSSResult = css`
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
`;
