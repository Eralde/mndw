export interface WidgetSize {
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export function getWidgetSize(size: WidgetSize): WidgetSize {
  return {
    ...size,
    w: Math.max(size.w, size.minW ?? size.w),
    h: Math.max(size.h, size.minH ?? size.h),
  };
}
