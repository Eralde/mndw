export interface FocusChainEntry {
  rowKey: string | undefined;
}

export function resolveFocusedRowKey(chain: readonly FocusChainEntry[]): string | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const rowKey = chain[index]?.rowKey;

    if (rowKey !== undefined) {
      return rowKey;
    }
  }

  return undefined;
}
