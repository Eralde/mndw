// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {MndwInput} from '../input/input.js';
import {MndwSelect} from '../select/select.js';
import {MndwSlider} from '../slider/slider.js';
import {MndwTextarea} from '../textarea/textarea.js';

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
  it('keeps the select focus ring on its focused trigger', () => {
    const css = stylesText(MndwSelect.styles);

    expect(ruleBody(css, ':host {')).toContain('border-radius: var(--mndw-radius-md);');
    expect(ruleBody(css, '[part=\'trigger\'] {')).toContain('border-radius: var(--mndw-radius-md);');

    const focusRule = ruleBody(css, '[part=\'trigger\']:focus-visible {');

    expect(focusRule).toContain(
      'outline: var(--mndw-focus-w) solid var(--_mndw-focus-ring, var(--mndw-focus-ring));',
    );
    expect(focusRule).toContain('outline-offset: 0.0625rem;');
  });

  it.each([
    ['input', MndwInput.styles],
    ['textarea', MndwTextarea.styles],
    ['select', MndwSelect.styles],
    ['slider', MndwSlider.styles],
  ])('%s uses shared invalid border and focus colors', (_name, styles) => {
    const css = stylesText(styles);

    expect(css).toContain(':host([invalid])');
    expect(css).toContain(':host([aria-invalid=\'true\'])');
    expect(css).toContain('--_mndw-field-border: var(--mndw-danger);');
    expect(css).toContain('--_mndw-focus-ring: var(--mndw-danger);');
    expect(css).toContain('var(--_mndw-field-border');
    expect(css).toContain('var(--_mndw-focus-ring');
  });
});
