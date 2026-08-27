import {afterEach, describe, expect, it} from 'vitest';
import {deepActiveElement} from './focus.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('deepActiveElement', () => {
  it('returns the focused element in the document tree', () => {
    const button = document.createElement('button');

    document.body.appendChild(button);
    button.focus();

    expect(deepActiveElement()).toBe(button);
  });

  it('pierces a shadow root', () => {
    const host = document.createElement('div');

    document.body.appendChild(host);

    const root = host.attachShadow({mode: 'open'});
    const button = document.createElement('button');

    root.appendChild(button);
    button.focus();

    expect(document.activeElement).toBe(host);
    expect(deepActiveElement()).toBe(button);
  });

  it('pierces nested shadow roots', () => {
    const outer = document.createElement('div');

    document.body.appendChild(outer);

    const outerRoot = outer.attachShadow({mode: 'open'});
    const inner = document.createElement('div');

    outerRoot.appendChild(inner);

    const innerRoot = inner.attachShadow({mode: 'open'});
    const button = document.createElement('button');

    innerRoot.appendChild(button);
    button.focus();

    expect(deepActiveElement()).toBe(button);
  });

  it('reports the body when nothing is focused', () => {
    expect(deepActiveElement()).toBe(document.body);
  });
});
