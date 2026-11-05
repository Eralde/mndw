// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {focusTrap} from './focus-trap-action.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function fixture(): {outside: HTMLButtonElement; node: HTMLDivElement; inside: HTMLButtonElement} {
  const outside = document.createElement('button');
  const node = document.createElement('div');
  const inside = document.createElement('button');

  node.append(inside);
  document.body.append(outside, node);
  outside.focus();

  return {outside, node, inside};
}

describe('focusTrap action', () => {
  it('traps by default and releases on destroy', () => {
    const {outside, node, inside} = fixture();
    const handle = focusTrap(node, undefined);

    expect(document.activeElement).toBe(inside);
    handle?.destroy?.();
    expect(document.activeElement).toBe(outside);
  });

  it('activates and deactivates through update({enabled})', () => {
    const {outside, node, inside} = fixture();
    const handle = focusTrap(node, {enabled: false});

    expect(document.activeElement).toBe(outside);

    handle?.update?.({enabled: true});
    expect(document.activeElement).toBe(inside);

    handle?.update?.({enabled: false});
    expect(document.activeElement).toBe(outside);

    outside.focus();
    expect(document.activeElement).toBe(outside);
    handle?.destroy?.();
  });

  it('waits for an inert node to become active before focusing', async () => {
    const {node, inside} = fixture();
    const handle = focusTrap(node, {enabled: false});

    node.setAttribute('inert', '');
    handle?.update?.({enabled: true});
    node.removeAttribute('inert');
    await Promise.resolve();

    expect(document.activeElement).toBe(inside);
    handle?.destroy?.();
  });
});
