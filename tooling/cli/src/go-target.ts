/** Product targets supported by daemon and plugin cross-builds. */
export const PRODUCT_TARGETS = ['aarch64', 'mips', 'mipsel'] as const;

export type ProductTarget = (typeof PRODUCT_TARGETS)[number];

export function isProductTarget(value: string): value is ProductTarget {
  return (PRODUCT_TARGETS as readonly string[]).includes(value);
}

/** Go toolchain environment for one product target. */
export interface GoTargetConfig {
  readonly GOARCH: string;
  readonly GOARM?: string;
  readonly GOMIPS?: string;
}

export const GO_TARGETS: Record<ProductTarget, GoTargetConfig> = {
  aarch64: {GOARCH: 'arm64'},
  mips: {GOARCH: 'mips', GOMIPS: 'softfloat'},
  mipsel: {GOARCH: 'mipsle', GOMIPS: 'softfloat'},
};

/** Builds a cross-build environment while leaving cache ownership to the caller. */
export function goTargetEnvironment(target: ProductTarget): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...GO_TARGETS[target],
    GOOS: 'linux',
    CGO_ENABLED: '0',
  };
}
