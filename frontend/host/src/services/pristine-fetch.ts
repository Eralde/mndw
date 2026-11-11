/** Captured before plugin modules are imported; plugins cannot replace host transport. */
export const pristineFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

/**
 * Same as {@link pristineFetch} but with a deadline: after `timeoutMs` the request is aborted
 * and the pending promise rejects with the abort reason. A caller-provided `init.signal` is
 * chained into the request, so aborting it aborts the fetch (and vice versa the returned
 * promise rejects).
 */
export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);

  if (parentSignal !== undefined && parentSignal !== null) {
    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener('abort', abortFromParent, {once: true});
    }
  }

  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await pristineFetch(input, {...init, signal: controller.signal});
  } finally {
    globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}
