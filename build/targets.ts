import {GO_TARGETS, type GoTargetConfig, type ProductTarget} from '@mndw/cli/go-target';

export {isProductTarget, PRODUCT_TARGETS} from '@mndw/cli/go-target';
export type {GoTargetConfig, ProductTarget} from '@mndw/cli/go-target';

export interface ProductTargetConfig {
  readonly go: GoTargetConfig;
  readonly opkgArch: 'aarch64-3.10' | 'mips-3.4' | 'mipsel-3.4';
  readonly entwareFeed: 'aarch64-k3.10' | 'mipssf-k3.4' | 'mipselsf-k3.4';
}

export const PRODUCT_TARGET_CONFIG: Readonly<Record<ProductTarget, ProductTargetConfig>> = {
  aarch64: {
    go: GO_TARGETS.aarch64,
    opkgArch: 'aarch64-3.10',
    entwareFeed: 'aarch64-k3.10',
  },
  mips: {
    go: GO_TARGETS.mips,
    opkgArch: 'mips-3.4',
    entwareFeed: 'mipssf-k3.4',
  },
  mipsel: {
    go: GO_TARGETS.mipsel,
    opkgArch: 'mipsel-3.4',
    entwareFeed: 'mipselsf-k3.4',
  },
};
