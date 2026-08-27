export interface TableGeometryProvider {
  createResizeObserver(callback: ResizeObserverCallback): ResizeObserver | null;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  measure(element: Element): DOMRectReadOnly;
  getViewportScrollTop(viewport: HTMLElement): number;
  setViewportScrollTop(viewport: HTMLElement, value: number): void;
  getViewportClientHeight(viewport: HTMLElement): number;
  getViewportContentWidth(viewport: HTMLElement): number;
}

export type TableMeasurementTarget =
  | {kind: 'viewport'}
  | {kind: 'header'}
  | {kind: 'summary'; rowKey: string}
  | {kind: 'detail'; rowKey: string};

const measurementTargets = new WeakMap<Element, TableMeasurementTarget>();

export function registerTableMeasurementTarget(element: Element, target: TableMeasurementTarget): void {
  measurementTargets.set(element, target);
}

export function lookupTableMeasurementTarget(element: Element): TableMeasurementTarget | undefined {
  return measurementTargets.get(element);
}

export function createDomTableGeometryProvider(): TableGeometryProvider {
  return {
    createResizeObserver(callback: ResizeObserverCallback): ResizeObserver | null {
      return typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(callback);
    },
    requestAnimationFrame(callback: FrameRequestCallback): number {
      return requestAnimationFrame(callback);
    },
    cancelAnimationFrame(handle: number): void {
      cancelAnimationFrame(handle);
    },
    measure(element: Element): DOMRectReadOnly {
      return element.getBoundingClientRect();
    },
    getViewportScrollTop(viewport: HTMLElement): number {
      return viewport.scrollTop;
    },
    setViewportScrollTop(viewport: HTMLElement, value: number): void {
      viewport.scrollTop = value;
    },
    getViewportClientHeight(viewport: HTMLElement): number {
      return viewport.clientHeight;
    },
    getViewportContentWidth(viewport: HTMLElement): number {
      return viewport.clientWidth;
    },
  };
}
