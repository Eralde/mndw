import type {MndwEvent, PluginEventFacade} from '@mndw/sdk';
import {eventSchema} from '@mndw/sdk-internal';
import {Observable, takeUntil} from 'rxjs';
import type {PluginLifetime} from '../runtime/plugin-lifetime.js';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_JITTER = 0.2;
const REPLAY_PAGE_SIZE = 100;
const LIVE_BUFFER_LIMIT = 1_024;
const DEDUP_LIMIT = 2_048;

type Timer = ReturnType<typeof globalThis.setTimeout>;
type EventHandler = (event: MndwEvent) => void;

interface Registration {
  readonly id: string;
  readonly pluginName: string;
  readonly grants: readonly string[];
  readonly subscriptions: Map<number, {filters: readonly string[]; handler: EventHandler}>;
  readonly resyncHandlers: Map<number, () => void>;
}

interface SocketMessage {
  readonly type: string;
  readonly event?: unknown;
  readonly events?: unknown;
  readonly hasMore?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

export interface EventStreamEnvironment {
  readonly WebSocket?: typeof WebSocket;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly random?: () => number;
  readonly diagnostic?: (message: string, error?: unknown) => void;
}

export interface EventStreamService {
  createFacade(
    instanceId: string,
    pluginName: string,
    permissions: readonly string[],
    lifetime: PluginLifetime,
  ): PluginEventFacade | undefined;
  disposeFacade(instanceId: string): void;
}

const splitFilters = (filters: string | readonly string[]): string[] => {
  const values = typeof filters === 'string' ? [filters] : [...filters];

  return values.flatMap((value) => value.split(',')).filter((value) => value.length > 0);
};

const matchesFilter = (filter: string, topic: string): boolean => {
  return filter === '*' || topic === filter || topic.startsWith(`${filter}.`);
};

const narrowerFilter = (left: string, right: string): string | undefined => {
  if (left === '*' || left === right || left.startsWith(`${right}.`)) {
    return left;
  }

  if (right === '*' || right.startsWith(`${left}.`)) {
    return right;
  }

  return undefined;
};

const effectiveFilters = (requested: readonly string[], grants: readonly string[]): string[] => {
  const result = new Set<string>();

  for (const request of requested) {
    for (const grant of grants) {
      const effective = narrowerFilter(request, grant);

      if (effective !== undefined) {
        result.add(effective);
      }
    }
  }

  return [...result];
};

const validPermissions = (permissions: readonly string[]): string[] => {
  const grants = new Set<string>();

  for (const permission of permissions) {
    if (!permission.startsWith('events:')) {
      continue;
    }

    const value = permission.slice('events:'.length);

    for (const grant of value.split(',')) {
      if (grant === '*' || /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(grant)) {
        grants.add(grant);
      }
    }
  }

  return [...grants];
};

const asObject = (value: unknown): Record<string, unknown> | undefined => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
};

export class EventStreamManager implements EventStreamService {
  private readonly socketFactory: typeof WebSocket | undefined;
  private readonly schedule: typeof globalThis.setTimeout;
  private readonly cancelSchedule: typeof globalThis.clearTimeout;
  private readonly random: () => number;
  private readonly diagnostic: (message: string, error?: unknown) => void;
  private readonly registrations = new Map<string, Registration>();
  private readonly deliveredIds = new Set<string>();
  private readonly deliveredOrder: string[] = [];
  private readonly liveBuffer: MndwEvent[] = [];
  private socket: WebSocket | undefined;
  private reconnectTimer: Timer | undefined;
  private reconnectAttempt = 0;
  private nextHandlerId = 1;
  private lastSeenId = '';
  private replayCursor = '';
  private catchingUp = false;
  private replaying = false;
  private closing = false;

  constructor(environment: EventStreamEnvironment = {}) {
    this.socketFactory = environment.WebSocket ?? (typeof WebSocket === 'undefined' ? undefined : WebSocket);
    this.schedule = environment.setTimeout ?? globalThis.setTimeout;
    this.cancelSchedule = environment.clearTimeout ?? globalThis.clearTimeout;
    this.random = environment.random ?? Math.random;
    this.diagnostic = environment.diagnostic ?? ((message, error) => console.warn(`[mndw] ${message}`, error));
  }

  public createFacade(
    instanceId: string,
    pluginName: string,
    permissions: readonly string[],
    lifetime: PluginLifetime,
  ): PluginEventFacade | undefined {
    const grants = validPermissions(permissions);

    if (grants.length === 0) {
      return undefined;
    }

    this.disposeFacade(instanceId);
    this.registrations.set(instanceId, {
      id: instanceId,
      pluginName,
      grants,
      subscriptions: new Map(),
      resyncHandlers: new Map(),
    });

    return {
      select$: (topics) =>
        new Observable<MndwEvent>((subscriber) => {
          const registration = this.registrations.get(instanceId);

          if (registration === undefined) {
            subscriber.complete();

            return;
          }

          const filters = effectiveFilters(splitFilters(topics), registration.grants);

          if (filters.length === 0) {
            subscriber.complete();

            return;
          }

          const id = this.nextHandlerId++;

          registration.subscriptions.set(id, {filters, handler: (event) => subscriber.next(event)});
          this.updateWireSubscription();

          return () => {
            if (registration.subscriptions.delete(id)) {
              this.updateWireSubscription();
            }
          };
        }).pipe(takeUntil(lifetime.ended$)),
      resync$: new Observable<void>((subscriber) => {
        const registration = this.registrations.get(instanceId);

        if (registration === undefined) {
          subscriber.complete();

          return;
        }

        const id = this.nextHandlerId++;

        registration.resyncHandlers.set(id, () => subscriber.next());

        return () => {
          registration.resyncHandlers.delete(id);
        };
      }).pipe(takeUntil(lifetime.ended$)),
    };
  }

  public disposeFacade(instanceId: string): void {
    if (!this.registrations.delete(instanceId)) {
      return;
    }

    this.updateWireSubscription();

    if (this.registrations.size === 0) {
      this.closeSocket();
    }
  }

  private effectiveWireFilters(): string[] {
    const filters = new Set<string>();

    for (const registration of this.registrations.values()) {
      for (const subscription of registration.subscriptions.values()) {
        for (const filter of subscription.filters) {
          filters.add(filter);
        }
      }
    }

    return [...filters].sort();
  }

  private ensureSocket(): void {
    if (
      this.socket !== undefined || this.reconnectTimer !== undefined || this.closing
      || this.effectiveWireFilters().length === 0
    ) {
      return;
    }

    if (this.socketFactory === undefined) {
      this.diagnostic('event stream WebSocket is unavailable');

      return;
    }

    const socket = new this.socketFactory('/ws/events');

    this.socket = socket;
    socket.addEventListener('open', () => this.handleOpen(socket));
    socket.addEventListener('message', (event) => this.handleMessage(socket, event.data));
    socket.addEventListener('close', () => this.handleClose(socket));
    socket.addEventListener('error', (error) => this.diagnostic('event stream socket error', error));
  }

  private handleOpen(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }

    this.reconnectAttempt = 0;
    this.sendSubscribe();
    this.catchingUp = true;
    this.replaying = false;
    this.replayCursor = this.lastSeenId;
    this.requestReplay(this.lastSeenId);
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }

    this.socket = undefined;

    if (this.registrations.size > 0 && !this.closing) {
      this.scheduleReconnect();
    }
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    if (this.socket !== socket || typeof data !== 'string') {
      return;
    }

    let decoded: unknown;

    try {
      decoded = JSON.parse(data);
    } catch (error) {
      this.diagnostic('event stream returned invalid JSON', error);

      return;
    }

    const message = asObject(decoded) as SocketMessage | undefined;

    if (message?.type === 'event') {
      this.handleIncomingEvent(message.event);
    } else if (message?.type === 'replay') {
      this.handleReplay(message);
    } else if (message?.type === 'error') {
      this.handleServerError(message);
    }
  }

  private handleIncomingEvent(raw: unknown): void {
    const parsed = eventSchema.safeParse(raw);

    if (!parsed.success) {
      this.diagnostic('event stream returned invalid event', parsed.error);

      return;
    }

    if (this.catchingUp) {
      if (this.liveBuffer.length >= LIVE_BUFFER_LIMIT) {
        this.liveBuffer.length = 0;
        this.closeActiveSocket();

        return;
      }

      this.liveBuffer.push(parsed.data);

      return;
    }

    this.deliver(parsed.data);
  }

  private handleReplay(message: SocketMessage): void {
    if (!this.catchingUp || !Array.isArray(message.events) || typeof message.hasMore !== 'boolean') {
      return;
    }

    const events = message.events.map((event) => eventSchema.safeParse(event)).filter((result) => result.success);

    for (const result of events) {
      if (result.success) {
        this.replayCursor = result.data.id;
        this.deliver(result.data);
      }
    }

    this.replaying = false;

    if (message.hasMore && this.replayCursor !== '') {
      this.requestReplay(this.replayCursor);

      return;
    }

    this.catchingUp = false;
    this.replaying = false;

    const buffered = this.liveBuffer.splice(0);

    for (const event of buffered) {
      this.deliver(event);
    }

    for (const registration of this.registrations.values()) {
      for (const handler of registration.resyncHandlers.values()) {
        try {
          handler();
        } catch (error) {
          this.diagnostic(`event resync handler failed for ${registration.pluginName}`, error);
        }
      }
    }
  }

  private handleServerError(message: SocketMessage): void {
    if (message.code === 'CURSOR_EXPIRED') {
      this.catchingUp = false;
      this.replaying = false;

      const buffered = this.liveBuffer.splice(0);

      for (const event of buffered) {
        this.deliver(event);
      }

      this.diagnostic('event stream replay cursor expired');

      for (const registration of this.registrations.values()) {
        for (const handler of registration.resyncHandlers.values()) {
          try {
            handler();
          } catch (error) {
            this.diagnostic(`event resync handler failed for ${registration.pluginName}`, error);
          }
        }
      }

      return;
    }

    const detail = typeof message.message === 'string'
      ? message.message
      : typeof message.code === 'string'
      ? message.code
      : 'unknown';

    this.diagnostic(`event stream server error: ${detail}`);
  }

  private deliver(event: MndwEvent): void {
    this.lastSeenId = event.id;

    if (this.deliveredIds.has(event.id)) {
      return;
    }

    this.deliveredIds.add(event.id);
    this.deliveredOrder.push(event.id);

    while (this.deliveredOrder.length > DEDUP_LIMIT) {
      const old = this.deliveredOrder.shift();

      if (old !== undefined) {
        this.deliveredIds.delete(old);
      }
    }

    for (const registration of this.registrations.values()) {
      for (const subscription of registration.subscriptions.values()) {
        if (!subscription.filters.some((filter) => matchesFilter(filter, event.topic))) {
          continue;
        }

        try {
          subscription.handler(event);
        } catch (error) {
          this.diagnostic(`event handler failed for ${registration.pluginName}`, error);
        }
      }
    }
  }

  private sendSubscribe(): void {
    this.send({type: 'subscribe', topics: this.effectiveWireFilters()});
  }

  private updateWireSubscription(): void {
    const filters = this.effectiveWireFilters();

    if (filters.length === 0) {
      this.closeSocket();

      return;
    }

    const socket = this.socket;

    if (socket?.readyState === 1 && !this.catchingUp) {
      this.send({type: 'subscribe', topics: filters});
    }

    this.ensureSocket();
  }

  private requestReplay(after: string): void {
    if (this.replaying) {
      return;
    }

    this.replaying = true;
    this.send({type: 'replay', after, limit: REPLAY_PAGE_SIZE});
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;

    if (socket?.readyState !== 1) {
      return;
    }

    socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.effectiveWireFilters().length === 0) {
      return;
    }

    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempt++);
    const jitter = 1 - RECONNECT_JITTER + this.random() * 2 * RECONNECT_JITTER;

    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = undefined;
      this.ensureSocket();
    }, Math.round(base * jitter));
  }

  private closeActiveSocket(): void {
    const socket = this.socket;

    if (socket === undefined) {
      return;
    }

    this.catchingUp = false;
    this.replaying = false;
    socket.close(1008, 'event stream catch-up overflow');
  }

  private closeSocket(): void {
    if (this.reconnectTimer !== undefined) {
      this.cancelSchedule(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.catchingUp = false;
    this.replaying = false;
    this.liveBuffer.length = 0;

    const socket = this.socket;

    this.socket = undefined;

    if (socket !== undefined) {
      socket.close(1000, 'no event subscribers');
    }
  }
}

export function createEventStreamService(environment: EventStreamEnvironment = {}): EventStreamService {
  return new EventStreamManager(environment);
}
