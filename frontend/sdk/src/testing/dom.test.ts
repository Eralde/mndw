// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {clearBody, nonNull, shadowOf, shadowQuery, shadowQueryAll} from './dom.js';

function hostWithShadow(html: string): HTMLElement {
  const el = document.createElement('div');

  el.attachShadow({mode: 'open'}).innerHTML = html;

  return el;
}

describe('dom test helpers', () => {
  it('shadowOf returns the open root and throws when absent', () => {
    const el = hostWithShadow('<span class="x">hi</span>');

    expect(shadowOf(el)).toBe(el.shadowRoot);
    expect(() => shadowOf(document.createElement('div'))).toThrow('expected open shadow root');
  });

  it('shadowQuery finds a node and throws a selector message on miss', () => {
    const el = hostWithShadow('<span class="x">hi</span>');

    expect(shadowQuery<HTMLSpanElement>(el, '.x').textContent).toBe('hi');
    expect(() => shadowQuery(el, '.missing')).toThrow('expected shadow element: .missing');
  });

  it('shadowQueryAll returns an array of all matches', () => {
    const el = hostWithShadow('<b>1</b><b>2</b>');

    expect(shadowQueryAll<HTMLElement>(el, 'b').map((n) => n.textContent)).toEqual(['1', '2']);
  });

  it('nonNull passes values through and throws on null/undefined', () => {
    expect(nonNull(5, 'n')).toBe(5);
    expect(() => nonNull(null, 'a thing')).toThrow('expected a thing');
    expect(() => nonNull(undefined, 'a thing')).toThrow('expected a thing');
  });

  it('clearBody empties document.body', () => {
    document.body.innerHTML = '<p>x</p>';
    clearBody();
    expect(document.body.innerHTML).toBe('');
  });
});
