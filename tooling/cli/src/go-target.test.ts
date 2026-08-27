import {describe, expect, it} from 'vitest';

import {GO_TARGETS, goTargetEnvironment, isProductTarget} from './go-target.js';

describe('go-target', () => {
  it('exposes one Go configuration per product target', () => {
    expect(Object.keys(GO_TARGETS).sort()).toEqual(['aarch64', 'mips', 'mipsel']);
  });

  it('preserves caller cache settings without inventing GOCACHE', () => {
    const original = process.env.GOCACHE;

    process.env.GOCACHE = '/cache/go';

    try {
      const env = goTargetEnvironment('aarch64');

      expect(env.GOOS).toBe('linux');
      expect(env.CGO_ENABLED).toBe('0');
      expect(env.GOARCH).toBe('arm64');
      expect(env.GOCACHE).toBe('/cache/go');
    } finally {
      if (original === undefined) {
        delete process.env.GOCACHE;
      } else {
        process.env.GOCACHE = original;
      }
    }
  });

  it('narrows product targets', () => {
    expect(isProductTarget('mips')).toBe(true);
    expect(isProductTarget('x86')).toBe(false);
  });
});
