function needsStub(ctor: unknown): boolean {
  if (typeof ctor !== 'function') {
    return true;
  }

  const proto = (ctor as {prototype?: {observe?: unknown}}).prototype;

  return typeof proto?.observe !== 'function';
}

class InertResizeObserver {
  constructor(_callback: unknown) {}
  public observe(): void {}
  public unobserve(): void {}
  public disconnect(): void {}
}

class InertMutationObserver {
  constructor(_callback: unknown) {}
  public observe(): void {}
  public disconnect(): void {}
  public takeRecords(): unknown[] {
    return [];
  }
}

// UNION of the stubs the two Angular setups hand-rolled. Guarded: replaces a
// global only when missing or its prototype lacks a callable `observe`. Idempotent.
export function installDomObserverStubs(): void {
  if (needsStub(globalThis.ResizeObserver)) {
    globalThis.ResizeObserver = InertResizeObserver as unknown as typeof ResizeObserver;
  }

  if (needsStub(globalThis.MutationObserver)) {
    globalThis.MutationObserver = InertMutationObserver as unknown as typeof MutationObserver;
  }
}
