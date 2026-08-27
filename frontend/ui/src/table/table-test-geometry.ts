import {type TableGeometryProvider, lookupTableMeasurementTarget} from './table-geometry.js';

export interface FakeGeometryControls {
  flushFrame(): void;
  deliverResize(targets: readonly Element[]): void;
  setScrollTop(value: number): void;
  setViewportRect(rect: DOMRectInit): void;
  setHeaderRect(rect: DOMRectInit): void;
  setViewportContentWidth(width: number): void;
  setRowHeights(rowHeights: ReadonlyMap<string, {summary?: number; detail?: number}>): void;
}

export type FakeTableGeometryProvider = TableGeometryProvider & FakeGeometryControls;

interface FakeGeometryInit {
  viewport: DOMRectInit;
  header: DOMRectInit;
  rowHeights: ReadonlyMap<string, {summary?: number; detail?: number}>;
  defaultSummaryHeight: number;
  defaultDetailHeight: number;
  scrollTop: number;
  contentWidth?: number;
}

interface FakeResizeObserver {
  readonly observe: (target: Element) => void;
  readonly unobserve: (target: Element) => void;
  readonly disconnect: () => void;
}

function rectFromInit(init: DOMRectInit): DOMRectReadOnly {
  const legacy = init as DOMRectInit & {left?: number; top?: number};
  const left = init.x ?? legacy.left ?? 0;
  const top = init.y ?? legacy.top ?? 0;
  const width = init.width ?? 0;
  const height = init.height ?? 0;

  return new DOMRect(left, top, width, height);
}

export function createFakeTableGeometryProvider(init: FakeGeometryInit): FakeTableGeometryProvider {
  let viewportRect = rectFromInit(init.viewport);
  let headerRect = rectFromInit(init.header);
  let scrollTop = init.scrollTop;
  let contentWidth = init.contentWidth ?? viewportRect.width;
  let rowHeights = new Map(init.rowHeights);
  let nextFrameHandle = 1;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  const resizeTargets = new Map<ResizeObserverCallback, Set<Element>>();

  const provider: FakeTableGeometryProvider = {
    createResizeObserver(callback: ResizeObserverCallback): ResizeObserver {
      resizeTargets.set(callback, new Set());

      const observer: FakeResizeObserver = {
        observe: (target: Element): void => {
          resizeTargets.get(callback)?.add(target);
        },
        unobserve: (target: Element): void => {
          resizeTargets.get(callback)?.delete(target);
        },
        disconnect: (): void => {
          resizeTargets.delete(callback);
        },
      };

      return observer as ResizeObserver;
    },
    requestAnimationFrame(callback: FrameRequestCallback): number {
      const handle = nextFrameHandle++;

      pendingFrames.set(handle, callback);

      return handle;
    },
    cancelAnimationFrame(handle: number): void {
      pendingFrames.delete(handle);
    },
    measure(element: Element): DOMRectReadOnly {
      const target = lookupTableMeasurementTarget(element);

      if (target === undefined) {
        throw new Error('measurement target is not registered');
      }

      if (target.kind === 'viewport') {
        return rectFromInit({
          x: viewportRect.x,
          y: viewportRect.y,
          width: contentWidth,
          height: viewportRect.height,
        });
      }

      if (target.kind === 'header') {
        return headerRect;
      }

      const rowHeight = rowHeights.get(target.rowKey);
      const height = target.kind === 'summary'
        ? rowHeight?.summary ?? init.defaultSummaryHeight
        : rowHeight?.detail ?? init.defaultDetailHeight;

      return rectFromInit({height});
    },
    getViewportScrollTop: (_viewport: HTMLElement): number => scrollTop,
    setViewportScrollTop: (_viewport: HTMLElement, value: number): void => {
      scrollTop = value;
    },
    getViewportClientHeight: (_viewport: HTMLElement): number => viewportRect.height,
    getViewportContentWidth: (_viewport: HTMLElement): number => contentWidth,
    flushFrame: (): void => {
      const callbacks = [...pendingFrames.values()];

      pendingFrames.clear();

      for (const callback of callbacks) {
        callback(0);
      }
    },
    deliverResize: (targets: readonly Element[]): void => {
      const entries = targets.map((target) => ({
        target,
        contentRect: provider.measure(target),
      })) as ResizeObserverEntry[];

      for (const [callback, observedTargets] of resizeTargets) {
        const observedEntries = entries.filter((entry) => observedTargets.has(entry.target));

        if (observedEntries.length > 0) {
          callback(observedEntries, {} as ResizeObserver);
        }
      }
    },
    setScrollTop: (value: number): void => {
      scrollTop = value;
    },
    setViewportRect: (rect: DOMRectInit): void => {
      viewportRect = rectFromInit(rect);
    },
    setHeaderRect: (rect: DOMRectInit): void => {
      headerRect = rectFromInit(rect);
    },
    setViewportContentWidth: (width: number): void => {
      contentWidth = width;
    },
    setRowHeights: (nextRowHeights: ReadonlyMap<string, {summary?: number; detail?: number}>): void => {
      rowHeights = new Map(nextRowHeights);
    },
  };

  return provider;
}
