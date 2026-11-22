export interface HistoryEntry {
  at: number;
  server: string;
  pingMs: number | null;
  jitterMs: number | null;
  downloadBps: number;
  uploadBps: number;
}

export function pushHistory(list: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...list].slice(0, 10);
}
