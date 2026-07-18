import {MAX_LOAD_HISTORY_POINTS as LOAD_HISTORY_LIMIT, normalizeHistory} from '../services/load-history.js';

export const MAX_LOAD_HISTORY_POINTS = LOAD_HISTORY_LIMIT;
export const prepareChartHistory = normalizeHistory;

export function hasChartHistory(history: number[]): boolean {
  return normalizeHistory(history).length > 0;
}
