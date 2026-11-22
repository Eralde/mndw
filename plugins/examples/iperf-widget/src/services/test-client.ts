import type {BackendClient} from '@mndw/sdk';
import type {Settings, Target} from '../model/settings.js';

export type Phase = 'ping' | 'download' | 'upload';
export type ErrorCode = 'busy' | 'server-busy' | 'unreachable' | 'iperf-missing' | 'invalid-input' | 'iperf-failed';
export const PING_SAMPLE_COUNT = 10;

export type ServerMessage =
  | {type: 'phase'; phase: Phase; port: number}
  | {type: 'pingSample'; index: number; ms: number | null}
  | {type: 'ping'; pingMs: number | null; jitterMs: number | null}
  | {type: 'interval'; phase: 'download' | 'upload'; second: number; bitsPerSecond: number}
  | {type: 'result'; phase: 'download' | 'upload'; bitsPerSecond: number}
  | {type: 'done'}
  | {type: 'stopped'}
  | {type: 'error'; code: ErrorCode; message: string};

type ClientMessage =
  | {type: 'start'; host: string; portFrom: number; portTo: number; duration: number; streams: number}
  | {type: 'stop'};

type Listener = (message: ServerMessage) => void;
type ErrorListener = (error: Error) => void;

const PHASES: readonly Phase[] = ['download', 'upload', 'ping'];
const TEST_PHASES: readonly ('download' | 'upload')[] = ['download', 'upload'];
const ERROR_CODES: readonly ErrorCode[] = [
  'busy',
  'server-busy',
  'unreachable',
  'iperf-missing',
  'invalid-input',
  'iperf-failed',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseServerMessage(value: unknown): ServerMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Invalid server message');
  }

  switch (value.type) {
    case 'phase':
      if (typeof value.phase === 'string' && PHASES.includes(value.phase as Phase) && Number.isInteger(value.port)) {
        return {type: 'phase', phase: value.phase as Phase, port: value.port as number};
      }

      break;
    case 'ping':
      if (
        (value.pingMs === null || finiteNumber(value.pingMs))
        && (value.jitterMs === null || finiteNumber(value.jitterMs))
      ) {
        return {type: 'ping', pingMs: value.pingMs, jitterMs: value.jitterMs};
      }

      break;
    case 'pingSample':
      if (
        Number.isInteger(value.index)
        && (value.index as number) >= 0
        && (value.index as number) < PING_SAMPLE_COUNT
        && (value.ms === null || finiteNumber(value.ms))
      ) {
        return {
          type: 'pingSample',
          index: value.index as number,
          ms: value.ms,
        };
      }

      break;
    case 'interval':
      if (
        typeof value.phase === 'string'
        && TEST_PHASES.includes(value.phase as 'download' | 'upload')
        && Number.isInteger(value.second)
        && finiteNumber(value.bitsPerSecond)
      ) {
        return {
          type: 'interval',
          phase: value.phase as 'download' | 'upload',
          second: value.second as number,
          bitsPerSecond: value.bitsPerSecond,
        };
      }

      break;
    case 'result':
      if (
        typeof value.phase === 'string'
        && TEST_PHASES.includes(value.phase as 'download' | 'upload')
        && finiteNumber(value.bitsPerSecond)
      ) {
        return {
          type: 'result',
          phase: value.phase as 'download' | 'upload',
          bitsPerSecond: value.bitsPerSecond,
        };
      }

      break;
    case 'done':
      return {type: 'done'};
    case 'stopped':
      return {type: 'stopped'};
    case 'error':
      if (
        typeof value.code === 'string'
        && ERROR_CODES.includes(value.code as ErrorCode)
        && typeof value.message === 'string'
      ) {
        return {type: 'error', code: value.code as ErrorCode, message: value.message};
      }

      break;
  }

  throw new Error(`Invalid server message: ${value.type}`);
}

export class TestClient {
  private readonly listeners = new Set<Listener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly pending: ClientMessage[] = [];
  private socket: WebSocket | undefined;

  public constructor(private readonly backend: BackendClient) {}

  public subscribe(listener: Listener, onError?: ErrorListener): () => void {
    this.listeners.add(listener);

    if (onError) {
      this.errorListeners.add(onError);
    }

    return () => {
      this.listeners.delete(listener);

      if (onError) {
        this.errorListeners.delete(onError);
      }
    };
  }

  public start(target: Target, settings: Pick<Settings, 'duration' | 'streams'>): void {
    this.send({
      type: 'start',
      host: target.host,
      portFrom: target.portFrom,
      portTo: target.portTo,
      duration: settings.duration,
      streams: settings.streams,
    });
  }

  public stop(): void {
    this.pending.length = 0;
    this.send({type: 'stop'});
  }

  public close(): void {
    this.pending.length = 0;

    const socket = this.socket;

    this.socket = undefined;
    socket?.close();
  }

  private send(message: ClientMessage): void {
    const socket = this.getSocket();

    if (socket.readyState === 1) {
      socket.send(JSON.stringify(message));

      return;
    }

    this.pending.push(message);
  }

  private getSocket(): WebSocket {
    const existing = this.socket;

    if (existing) {
      return existing;
    }

    const socket = this.backend.socket('test');

    this.socket = socket;
    socket.onopen = () => this.flushPending();
    socket.onmessage = (event: MessageEvent) => this.receive(event.data);
    socket.onerror = () => this.reportError(new Error('WebSocket connection error'));
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }

      this.reportError(new Error('WebSocket connection closed'));
    };

    return socket;
  }

  private flushPending(): void {
    const socket = this.socket;

    if (socket?.readyState !== 1) {
      return;
    }

    for (const message of this.pending.splice(0)) {
      socket.send(JSON.stringify(message));
    }
  }

  private receive(data: unknown): void {
    try {
      const raw = typeof data === 'string' ? JSON.parse(data) as unknown : data;
      const message = parseServerMessage(raw);

      for (const listener of this.listeners) {
        listener(message);
      }
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private reportError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}
