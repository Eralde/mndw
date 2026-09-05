import type {TransitionEventType, TransitionLogEntry} from './transition-log.types';

export interface TransitionLogFilters {
  eventTypes: readonly TransitionEventType[];
  client: string;
  source: string;
  target: string;
  currentSince: number | null;
}

export const ALL_TRANSITION_EVENT_TYPES: readonly TransitionEventType[] = [
  'connected',
  'left',
  'transition',
  'pmk-cache',
  'fast-transition',
];

function includesText(value: string | null, query: string): boolean {
  return query.trim() === '' || (value ?? '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function filterTransitionLog(
  entries: readonly TransitionLogEntry[],
  filters: TransitionLogFilters,
): TransitionLogEntry[] {
  const types = filters.eventTypes.length === 0 ? ALL_TRANSITION_EVENT_TYPES : filters.eventTypes;

  return entries
    .filter((entry) => types.includes(entry.eventType))
    .filter((entry) => filters.currentSince === null || entry.timestamp >= filters.currentSince)
    .filter((entry) => includesText(entry.client, filters.client))
    .filter((entry) => includesText(entry.from, filters.source))
    .filter((entry) => includesText(entry.to, filters.target));
}

export function currentTransitionLogFilters(now: number): TransitionLogFilters {
  return {eventTypes: [...ALL_TRANSITION_EVENT_TYPES], client: '', source: '', target: '', currentSince: now};
}
