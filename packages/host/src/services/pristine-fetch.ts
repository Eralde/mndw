/** Captured before plugin modules are imported; plugins cannot replace host transport. */
export const pristineFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await pristineFetch(input, {...init, signal: controller.signal});
  } finally {
    globalThis.clearTimeout(timer);
  }
}
