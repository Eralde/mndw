export class TestResizeObserver implements ResizeObserver {
  public static readonly instances: TestResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  private observedTarget: Element | undefined;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }

  public observe(target: Element, _options?: ResizeObserverOptions): void {
    this.observedTarget = target;
  }

  public unobserve(target: Element): void {
    if (this.observedTarget === target) {
      this.observedTarget = undefined;
    }
  }

  public disconnect(): void {
    this.observedTarget = undefined;
  }

  public resize(width: number): void {
    const target = this.observedTarget;

    if (target === undefined) {
      throw new Error('ResizeObserver is not observing an element');
    }

    const contentRect = new DOMRect(0, 0, width, 0);
    const entry = {target, contentRect} as ResizeObserverEntry;

    this.callback([entry], this);
  }

  public static reset(): void {
    TestResizeObserver.instances.length = 0;
  }

  public static observing(target: Element): TestResizeObserver {
    const observer = [...TestResizeObserver.instances].reverse().find((candidate) =>
      candidate.observedTarget === target
    );

    if (observer === undefined) {
      throw new Error('ResizeObserver is not observing the requested element');
    }

    return observer;
  }
}
