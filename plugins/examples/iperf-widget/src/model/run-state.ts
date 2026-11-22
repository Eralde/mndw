import type {MndwChartPoint} from '@mndw/ui';
import {formatBitRate} from './format.js';
import type {RunView} from './run-view.js';
import {type ErrorCode, PING_SAMPLE_COUNT, type Phase, type ServerMessage} from '../services/test-client.js';

const PING_SAMPLE_INTERVAL_MS = 200;

export type RunStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error';
export type RunStatusMessage =
  | 'status.running'
  | 'status.done'
  | 'status.stopped'
  | 'error.invalid-input'
  | 'error.connection-lost'
  | `error.${ErrorCode}`;

export interface RunState {
  readonly status: RunStatus;
  readonly phase: Phase | null;
  readonly activePort: number | null;
  readonly speed: number;
  readonly pingMs: number | null;
  readonly jitterMs: number | null;
  readonly pingSamples: readonly (number | null)[];
  readonly latestPingSample: number | null;
  readonly pingSampleStart: number;
  readonly downloadBps: number | null;
  readonly uploadBps: number | null;
  readonly downloadPoints: readonly MndwChartPoint[];
  readonly uploadPoints: readonly MndwChartPoint[];
  readonly statusMessage: RunStatusMessage | null;
}

export interface RunViewOptions {
  readonly locale: string;
  readonly emptyValue: string;
  readonly uploadOffsetSeconds: number;
  readonly label: (key: string) => string;
  readonly formatPing: (value: number) => string;
}

export function initialRunState(now: number = Date.now()): RunState {
  return {
    status: 'idle',
    phase: null,
    activePort: null,
    speed: 0,
    pingMs: null,
    jitterMs: null,
    pingSamples: Array.from({length: PING_SAMPLE_COUNT}, () => null),
    latestPingSample: null,
    pingSampleStart: now,
    downloadBps: null,
    uploadBps: null,
    downloadPoints: [],
    uploadPoints: [],
    statusMessage: null,
  };
}

export function startRun(_state: Readonly<RunState>, now: number): RunState {
  return {
    ...initialRunState(now),
    status: 'running',
    statusMessage: 'status.running',
  };
}

export function applyServerMessage(state: Readonly<RunState>, message: ServerMessage, now: number): RunState {
  switch (message.type) {
    case 'phase':
      return {
        ...state,
        phase: message.phase,
        activePort: message.port,
        speed: 0,
        pingSampleStart: message.phase === 'ping' ? now : state.pingSampleStart,
        latestPingSample: message.phase === 'ping' ? null : state.latestPingSample,
      };
    case 'ping':
      return {
        ...state,
        pingMs: message.pingMs,
        jitterMs: message.jitterMs,
      };
    case 'pingSample': {
      const pingSamples = message.index >= 0 && message.index < PING_SAMPLE_COUNT
        ? state.pingSamples.map((sample, index) => index === message.index ? message.ms : sample)
        : state.pingSamples;

      return {
        ...state,
        pingSamples,
        latestPingSample: message.ms,
      };
    }
    case 'interval': {
      const point = {time: message.second, value: message.bitsPerSecond};

      if (message.phase === 'download') {
        return {
          ...state,
          phase: message.phase,
          speed: message.bitsPerSecond,
          downloadPoints: [...state.downloadPoints, point],
        };
      }

      return {
        ...state,
        phase: message.phase,
        speed: message.bitsPerSecond,
        uploadPoints: [...state.uploadPoints, point],
      };
    }
    case 'result':
      return message.phase === 'download'
        ? {
          ...state,
          phase: message.phase,
          speed: message.bitsPerSecond,
          downloadBps: message.bitsPerSecond,
        }
        : {
          ...state,
          phase: message.phase,
          speed: message.bitsPerSecond,
          uploadBps: message.bitsPerSecond,
        };
    case 'done':
      return {
        ...state,
        status: 'done',
        speed: 0,
        statusMessage: 'status.done',
      };
    case 'stopped':
      return {
        ...state,
        status: 'stopped',
        statusMessage: 'status.stopped',
      };
    case 'error':
      return {
        ...state,
        status: 'error',
        statusMessage: `error.${message.code}`,
      };
  }
}

export function toRunView(state: Readonly<RunState>, options: RunViewOptions): Readonly<RunView> {
  const phaseCode = state.phase ?? (state.status === 'running' ? 'ping' : 'idle');
  const lineDownload = state.downloadBps === null
    ? options.emptyValue
    : formatBitRate(state.downloadBps, options.locale);
  const lineUpload = state.uploadBps === null
    ? options.emptyValue
    : formatBitRate(state.uploadBps, options.locale);
  const linePing = state.pingMs === null ? options.emptyValue : options.formatPing(state.pingMs);
  const lineSpeed = state.status === 'running' && state.phase === 'ping'
    ? state.latestPingSample === null ? options.emptyValue : options.formatPing(state.latestPingSample)
    : state.status !== 'running' && state.statusMessage !== null
    ? options.label(state.statusMessage)
    : formatBitRate(state.speed, options.locale);
  const highestSample = Math.max(0, ...state.pingSamples.filter((sample): sample is number => sample !== null));

  return {
    labels: {
      start: options.label('action.start'),
      stop: options.label('action.stop'),
      download: options.label('result.download'),
      upload: options.label('result.upload'),
      ping: options.label('result.ping'),
      jitter: options.label('result.jitter'),
      chartEmpty: options.label('chart.empty'),
      chartSeconds: options.label('chart.seconds'),
      chartSpeed: options.label('chart.speed'),
    },
    phase: state.phase,
    phaseLabel: options.label(`phase.${phaseCode}`),
    currentValue: lineSpeed,
    speed: state.speed,
    results: {
      download: lineDownload,
      upload: lineUpload,
      ping: linePing,
      jitter: state.jitterMs === null ? options.emptyValue : options.formatPing(state.jitterMs),
      summary: `↓ ${lineDownload}  ↑ ${lineUpload}  ${options.label('result.ping')} ${linePing}`,
    },
    pingSamples: state.pingSamples,
    pingPoints: state.pingSamples.map((sample, index) => ({
      time: state.pingSampleStart + index * PING_SAMPLE_INTERVAL_MS,
      value: sample ?? 0,
    })),
    pingDomain: {min: 0, max: Math.max(100, Math.ceil(highestSample / 50) * 50)},
    downloadSeries: state.downloadPoints,
    uploadSeries: state.uploadPoints.map((point) => ({
      time: point.time + options.uploadOffsetSeconds,
      value: point.value,
    })),
    running: state.status === 'running',
    statusText: state.statusMessage === null ? '' : options.label(state.statusMessage),
  };
}
