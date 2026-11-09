import type {MndwEvent, TelemetryGathering} from '@mndw/sdk';
import type {EventStreamService} from './event-stream.service.js';
import {createPluginLifetime} from '../runtime/plugin-lifetime.js';

export interface TelemetryGatheringService {
  get(): TelemetryGathering | null;
  subscribe(listener: () => void): () => void;
  report(enabled: boolean): void;
}

export interface TelemetryGatheringDependencies {
  getTelemetry(): Promise<{enabled: boolean}>;
  eventStream: EventStreamService;
}

let serviceSequence = 0;

export function createTelemetryGatheringService(
  dependencies: TelemetryGatheringDependencies,
): TelemetryGatheringService {
  const listeners = new Map<number, () => void>();
  const facadeId = `host-telemetry-gathering:${++serviceSequence}`;
  let nextListenerId = 1;
  let current: TelemetryGathering | null = null;
  let requestRevision = 0;
  let lifetime: ReturnType<typeof createPluginLifetime> | undefined;
  let eventFacadeAttached = false;

  const notify = (): void => {
    for (const listener of [...listeners.values()]) {
      listener();
    }
  };

  const set = (enabled: boolean): void => {
    if (current?.enabled === enabled) {
      return;
    }

    current = Object.freeze({enabled});
    notify();
  };

  const refresh = (): void => {
    const revision = ++requestRevision;

    void dependencies.getTelemetry()
      .then(({enabled}) => {
        if (revision === requestRevision) {
          set(enabled);
        }
      })
      .catch(() => {});
  };

  const stop = (): void => {
    if (lifetime === undefined) {
      return;
    }

    const activeLifetime = lifetime;

    lifetime = undefined;
    activeLifetime.end();

    if (eventFacadeAttached) {
      eventFacadeAttached = false;
      dependencies.eventStream.disposeFacade(facadeId);
    }
  };

  const start = (): void => {
    lifetime = createPluginLifetime();

    const facade = dependencies.eventStream.createFacade(facadeId, 'host', ['events:telemetry'], lifetime);

    if (facade !== undefined) {
      eventFacadeAttached = true;
      facade.select$('telemetry.gathering_changed').subscribe((event: MndwEvent) => {
        if (event.topic === 'telemetry.gathering_changed') {
          requestRevision += 1;
          set(event.payload.enabled);
        }
      });
      facade.resync$.subscribe(refresh);
    }

    refresh();
  };

  return {
    get: (): TelemetryGathering | null => current,
    subscribe: (listener): () => void => {
      const id = nextListenerId++;

      listeners.set(id, listener);

      if (listeners.size === 1) {
        start();
      }

      return (): void => {
        if (!listeners.delete(id)) {
          return;
        }

        if (listeners.size === 0) {
          stop();
        }
      };
    },
    report: (enabled): void => {
      requestRevision += 1;
      set(enabled);
    },
  };
}
