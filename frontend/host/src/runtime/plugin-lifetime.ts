import {Observable, ReplaySubject} from 'rxjs';

export interface PluginLifetime {
  readonly ended$: Observable<void>;
  readonly ended: boolean;
  end(): void;
}

export function createPluginLifetime(): PluginLifetime {
  const endedSubject = new ReplaySubject<void>(1);
  let ended = false;
  const lifetime: PluginLifetime = {
    ended$: endedSubject.asObservable(),
    get ended(): boolean {
      return ended;
    },
    end: (): void => {
      if (ended) {
        return;
      }

      ended = true;
      endedSubject.next();
      endedSubject.complete();
    },
  };

  return Object.freeze(lifetime);
}

export function hostValue$<T>(
  read: () => T,
  listen: (callback: (value: T) => void) => () => void,
  lifetime: PluginLifetime,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    if (lifetime.ended) {
      subscriber.complete();

      return undefined;
    }

    let unsubscribeHost: (() => void) | undefined;
    const stopListening = (): void => {
      const unsubscribe = unsubscribeHost;

      unsubscribeHost = undefined;
      unsubscribe?.();
    };
    const lifetimeSubscription = lifetime.ended$.subscribe(() => {
      stopListening();
      subscriber.complete();
    });

    subscriber.next(read());

    if (!subscriber.closed && !lifetime.ended) {
      unsubscribeHost = listen((value) => subscriber.next(value));

      if (lifetime.ended) {
        stopListening();
      }
    }

    return () => {
      lifetimeSubscription.unsubscribe();
      stopListening();
    };
  });
}

export function hostSignal$(
  listen: (callback: () => void) => () => void,
  lifetime: PluginLifetime,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    if (lifetime.ended) {
      subscriber.complete();

      return undefined;
    }

    let unsubscribeHost: (() => void) | undefined;
    const stopListening = (): void => {
      const unsubscribe = unsubscribeHost;

      unsubscribeHost = undefined;
      unsubscribe?.();
    };
    const lifetimeSubscription = lifetime.ended$.subscribe(() => {
      stopListening();
      subscriber.complete();
    });

    unsubscribeHost = listen(() => subscriber.next());

    if (lifetime.ended) {
      stopListening();
    }

    return () => {
      lifetimeSubscription.unsubscribe();
      stopListening();
    };
  });
}
