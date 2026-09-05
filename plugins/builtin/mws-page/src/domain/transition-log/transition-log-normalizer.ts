import type {
  RawTransitionLogEndpoint,
  RawTransitionLogEvent,
  RawTransitionLogFrame,
  TransitionEventType,
  TransitionLogEntry,
} from './transition-log.types';

const MONTHS = new Map([
  ['jan', 0],
  ['feb', 1],
  ['mar', 2],
  ['apr', 3],
  ['may', 4],
  ['jun', 5],
  ['jul', 6],
  ['aug', 7],
  ['sep', 8],
  ['oct', 9],
  ['nov', 10],
  ['dec', 11],
]);

function display(value: string | number | undefined, names: Readonly<Record<string, string>>): string | null {
  if (value === undefined || String(value).trim() === '') {
    return null;
  }

  const stringValue = String(value);

  return names[stringValue] ?? stringValue;
}

function endpointAp(value: string | RawTransitionLogEndpoint | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.ap;
}

function endpointBand(value: string | RawTransitionLogEndpoint | undefined): string | number | undefined {
  return typeof value === 'string' ? undefined : value?.band;
}

export function parseTransitionTimestamp(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined) {
    return null;
  }

  const match = /^(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());

  if (match === null) {
    return null;
  }

  const month = MONTHS.get(match[1]?.toLowerCase() ?? '');
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);

  if (
    month === undefined || !Number.isInteger(day) || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }

  const current = new Date(now);

  let timestamp = new Date(current.getFullYear(), month, day, hour, minute, second).getTime();

  const halfYear = 183 * 24 * 60 * 60 * 1000;

  if (timestamp - now > halfYear) {
    timestamp = new Date(current.getFullYear() - 1, month, day, hour, minute, second).getTime();
  } else if (now - timestamp > halfYear) {
    timestamp = new Date(current.getFullYear() + 1, month, day, hour, minute, second).getTime();
  }

  return timestamp;
}

function eventType(event: RawTransitionLogEvent): TransitionEventType | null {
  if (event.left === undefined && event.ap !== undefined) {
    return 'connected';
  }

  if (event.left !== undefined && event.ap === undefined) {
    return 'left';
  }

  if (event.left !== undefined && event.ap !== undefined) {
    return event.roam === 'ft' ? 'fast-transition' : event.roam === 'pmk' ? 'pmk-cache' : 'transition';
  }

  return null;
}

export function normalizeTransitionLogFrame(
  frame: RawTransitionLogFrame | unknown,
  names: Readonly<Record<string, string>> = {},
  now = Date.now(),
): TransitionLogEntry[] {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return [];
  }

  const log = (frame as RawTransitionLogFrame).log;

  if (typeof log !== 'object' || log === null || Array.isArray(log)) {
    return [];
  }

  return Object.entries(log)
    .map(([key, event]) => {
      const timestamp = parseTransitionTimestamp(event.timestamp, now);
      const type = eventType(event);

      if (timestamp === null || type === null || typeof event.mac !== 'string' || event.mac.trim() === '') {
        return null;
      }

      return {
        timestamp,
        client: display(event.mac, names) ?? event.mac,
        from: display(endpointAp(event.left), names),
        to: display(event.ap, names),
        band: display(event.band ?? endpointBand(event.left), names),
        segment: display(event.segment, names),
        eventType: type,
        id: String(event.id ?? key),
      } satisfies TransitionLogEntry;
    })
    .filter((entry): entry is TransitionLogEntry => entry !== null)
    .sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id));
}
