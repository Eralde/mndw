/**
 * Runs optional backend work without making host startup depend on its latency or availability.
 * The rejection handler is attached immediately so backend failures cannot become unhandled
 * promise rejections.
 */
export function startOptionalStartupWork(work: () => Promise<void>): void {
  void Promise.resolve()
    .then(work)
    .catch(() => {
      console.warn('[mndw] Optional backend startup work failed; continuing.');
    });
}
