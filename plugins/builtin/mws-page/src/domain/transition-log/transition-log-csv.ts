import type {TransitionLogEntry} from './transition-log.types';

const HEADERS = ['timestamp', 'client', 'source', 'target', 'band', 'segment', 'event type'];

function escape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function transitionLogCsv(entries: readonly TransitionLogEntry[]): string {
  const rows = entries.map((entry) => {
    const items = [
      new Date(entry.timestamp).toISOString(),
      entry.client,
      entry.from ?? '',
      entry.to ?? '',
      entry.band ?? '',
      entry.segment ?? '',
      entry.eventType,
    ];

    return items.map(escape).join(',');
  });

  return [HEADERS.join(','), ...rows].join('\n');
}
