export const PRODUCT_TARGETS = ['mipsel-3.4', 'aarch64-3.10', 'armv7-3.2'] as const;

export type ProductTarget = (typeof PRODUCT_TARGETS)[number];

export function isProductTarget(value: string): value is ProductTarget {
  return (PRODUCT_TARGETS as readonly string[]).includes(value);
}
