import {describe, expect, it} from 'vitest';
import {findUnscopedCssSelectors} from './css-scope-validator.js';

describe('findUnscopedCssSelectors', () => {
  it('accepts plugin-prefixed selectors', () => {
    expect(findUnscopedCssSelectors('.sample-widget { color: red } .sample-widget h1 { color: blue }', 'sample-widget'))
      .toEqual([]);
  });

  it('accepts compounds, descendants, and child selectors under the plugin root', () => {
    const css = [
      '.sample-widget.active { color: red }',
      '.sample-widget:hover { color: red }',
      '.sample-widget[data-state="active"] { color: red }',
      '.sample-widget::before { content: "" }',
      '.sample-widget .child { color: red }',
      '.sample-widget > .child { color: red }',
    ].join('\n');

    expect(findUnscopedCssSelectors(css, 'sample-widget')).toEqual([]);
  });

  it('reports adjacent and general sibling selectors that escape the plugin root', () => {
    expect(findUnscopedCssSelectors(
      '.sample-widget + main { color: red } .sample-widget ~ * { color: blue }',
      'sample-widget',
    )).toEqual(['.sample-widget + main', '.sample-widget ~ *']);
  });

  it('reports sibling escapes after qualified plugin roots', () => {
    const css = [
      '.sample-widget.active + main { color: red }',
      '.sample-widget:hover~* { color: red }',
      '.sample-widget[data-state=active] + main { color: red }',
    ].join('\n');

    expect(findUnscopedCssSelectors(css, 'sample-widget')).toEqual([
      '.sample-widget.active + main',
      '.sample-widget:hover~*',
      '.sample-widget[data-state=active] + main',
    ]);
  });

  it('accepts sibling combinators inside the plugin root and child selectors', () => {
    const css = '.sample-widget .child + .sibling { color: red } .sample-widget > .child { color: blue }';

    expect(findUnscopedCssSelectors(css, 'sample-widget')).toEqual([]);
  });

  it('ignores escaped and nested sibling symbols inside the root compound', () => {
    const css = [
      '.sample-widget[data-state="active+pending"] { color: red }',
      '.sample-widget:not(.child + .sibling) { color: red }',
      '.sample-widget.foo\\+bar { color: red }',
    ].join('\n');

    expect(findUnscopedCssSelectors(css, 'sample-widget')).toEqual([]);
  });

  it('reports each unprefixed selector in selector lists and nested at-rules', () => {
    expect(findUnscopedCssSelectors(
      '.sample-widget, body { color: red } @media (width > 1px) { button { color: blue } }',
      'sample-widget',
    )).toEqual(['body', 'button']);
  });

  it('allows exact third-party selectors from the package allowlist', () => {
    expect(findUnscopedCssSelectors('.sample-widget { color: red } .vendor-chart { color: blue }', 'sample-widget', [
      '.vendor-chart',
    ])).toEqual([]);
  });

  it('allows root token declarations and skips keyframe steps', () => {
    expect(findUnscopedCssSelectors(
      ':root { --sample-token: red } @keyframes pulse { from { opacity: 0 } to { opacity: 1 } }',
      'sample-widget',
    )).toEqual([]);
  });

  it('does not treat braces inside custom property values as selectors', () => {
    expect(findUnscopedCssSelectors('.sample-widget { --payload: { color: red; }; }', 'sample-widget')).toEqual([]);
  });
});
