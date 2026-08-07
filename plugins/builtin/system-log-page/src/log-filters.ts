import type {LogLevel, NormalizedLogRecord} from './log-types';

export interface FilterState {
  readonly query: string;
  readonly levels: ReadonlySet<LogLevel>;
}

export const ALL_LOG_LEVELS: readonly LogLevel[] = ['Info', 'Warning', 'Error', 'Critical', 'Debug', 'Notice'];

export function filterRecords(records: readonly NormalizedLogRecord[], state: FilterState): NormalizedLogRecord[] {
  const query = state.query.toLocaleLowerCase();

  return records.filter((record) => {
    if (!state.levels.has(record.level)) {
      return false;
    }

    if (query.length === 0) {
      return true;
    }

    return [record.timestamp, record.ident, record.level, record.label, record.text]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query);
  });
}

export function isFilterActive(state: FilterState): boolean {
  return state.query.trim().length > 0 || ALL_LOG_LEVELS.some((level) => !state.levels.has(level));
}
