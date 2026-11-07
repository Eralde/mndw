// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {MndwSelect} from '../select/select.js';

function stylesText(styles: unknown): string {
  if (Array.isArray(styles)) {
    return styles.map(stylesText).join('\n');
  }

  return String(styles);
}

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);

  expect(start, selector).toBeGreaterThanOrEqual(0);

  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);

  return css.slice(open + 1, close);
}

describe('interactive focus contract', () => {
  it('keeps the select focus ring on a host rounded to match its trigger', () => {
    const css = stylesText(MndwSelect.styles);

    expect(ruleBody(css, ':host {')).toContain('border-radius: var(--mndw-radius-md);');
    expect(ruleBody(css, '[part=\'trigger\'] {')).toContain('border-radius: var(--mndw-radius-md);');

    const focusRule = ruleBody(css, ':host(:focus-visible) {');

    expect(focusRule).toContain('outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);');
    expect(focusRule).toContain('outline-offset: 0.0625rem;');
  });
});
