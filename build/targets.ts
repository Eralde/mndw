export const PRODUCT_TARGETS = ['aarch64', 'mips', 'mipsel'] as const;

export type ProductTarget = (typeof PRODUCT_TARGETS)[number];

export interface GoTargetConfig {
  readonly GOARCH: string;
  readonly GOARM?: string;
  readonly GOMIPS?: string;
}

export interface ProductTargetConfig {
  readonly go: GoTargetConfig;
  readonly opkgArch: 'aarch64-3.10' | 'mips-3.4' | 'mipsel-3.4';
  readonly entwareFeed: 'aarch64-k3.10' | 'mipssf-k3.4' | 'mipselsf-k3.4';
}

export const PRODUCT_TARGET_CONFIG: Readonly<Record<ProductTarget, ProductTargetConfig>> = {
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
};

export function isProductTarget(value: string): value is ProductTarget {
  return (PRODUCT_TARGETS as readonly string[]).includes(value);
}
