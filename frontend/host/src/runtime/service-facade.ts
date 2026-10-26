/**
 * Builds a fresh, frozen facade over `target` exposing only `methods`, each bound to
 * `target`. Handing this to a plugin instead of the shared singleton means the plugin
 * cannot monkeypatch the real service or its prototype: the facade is frozen and its
 * methods are bound copies. The `ServiceFacade<T, K>` result type omits non-function selections;
 * the runtime guard also skips invalid names supplied dynamically.
 */
type AnyFunction = (...args: any[]) => any;

type ServiceFacade<T extends object, K extends keyof T> = {
  [P in K as T[P] extends AnyFunction ? P : never]: T[P] extends AnyFunction ? OmitThisParameter<T[P]> : never;
};

export function createServiceFacade<T extends object, K extends keyof T>(
  target: T,
  methods: readonly K[],
): ServiceFacade<T, K> {
  const facade: Record<PropertyKey, unknown> = Object.create(null);

  for (const name of methods) {
    const value = target[name];

    if (typeof value === 'function') {
      facade[name as PropertyKey] = (value as (...args: unknown[]) => unknown).bind(target);
    }
  }

  return Object.freeze(facade) as ServiceFacade<T, K>;
}
