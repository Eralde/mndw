// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {installDomObserverStubs} from './observers.js';

describe('installDomObserverStubs', () => {
  const savedResize = globalThis.ResizeObserver;
  const savedMutation = globalThis.MutationObserver;

  afterEach(() => {
    globalThis.ResizeObserver = savedResize;
    globalThis.MutationObserver = savedMutation;
  });

  it('installs an inert ResizeObserver when the global is missing', () => {
    // @ts-expect-error deliberately remove for the test
    delete globalThis.ResizeObserver;
    installDomObserverStubs();
    expect(typeof globalThis.ResizeObserver).toBe('function');

    const ro = new globalThis.ResizeObserver(() => {});

    expect(() => {
      ro.observe(document.body);
      ro.disconnect();
    }).not.toThrow();
  });

  it('does not replace a real observer that already has a callable observe', () => {
    const marker = globalThis.ResizeObserver;

    installDomObserverStubs();
    expect(globalThis.ResizeObserver).toBe(marker);
  });

  it('installs a MutationObserver stub when the prototype lacks a callable observe', () => {
    class Broken {}

    // @ts-expect-error install a broken observer whose prototype has no observe
    globalThis.MutationObserver = Broken;
    installDomObserverStubs();
    expect(typeof globalThis.MutationObserver.prototype.observe).toBe('function');
  });
});
