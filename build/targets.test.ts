import {describe, expect, it} from 'vitest';
import {PRODUCT_TARGETS, PRODUCT_TARGET_CONFIG, isProductTarget} from './targets.js';

describe('product targets', () => {
  it('exposes the supported bare target labels in stable order', () => {
    expect(PRODUCT_TARGETS).toEqual(['aarch64', 'mips', 'mipsel']);
    expect(isProductTarget('aarch64')).toBe(true);
    expect(isProductTarget('mips')).toBe(true);
    expect(isProductTarget('mipsel')).toBe(true);
    expect(isProductTarget('legacy-arm-target')).toBe(false);
  });

  it('keeps Go, opkg, and Entware feed labels together', () => {
    expect(PRODUCT_TARGET_CONFIG).toEqual({
      aarch64: {
        go: {GOARCH: 'arm64'},
        opkgArch: 'aarch64-3.10',
        entwareFeed: 'aarch64-k3.10',
      },
      mips: {
        go: {GOARCH: 'mips', GOMIPS: 'softfloat'},
        opkgArch: 'mips-3.4',
        entwareFeed: 'mipssf-k3.4',
      },
      mipsel: {
        go: {GOARCH: 'mipsle', GOMIPS: 'softfloat'},
        opkgArch: 'mipsel-3.4',
        entwareFeed: 'mipselsf-k3.4',
      },
    });
  });
});
