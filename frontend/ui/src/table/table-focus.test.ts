import {describe, expect, it} from 'vitest';
import {type FocusChainEntry, resolveFocusedRowKey} from './table-focus.js';

describe('resolveFocusedRowKey', () => {
  it('returns deepest defined row key', () => {
    const chain: FocusChainEntry[] = [{rowKey: 'outer'}, {rowKey: undefined}, {rowKey: 'inner'}];

    expect(resolveFocusedRowKey(chain)).toBe('inner');
  });

  it('returns undefined for empty or unowned chains', () => {
    expect(resolveFocusedRowKey([])).toBeUndefined();
    expect(resolveFocusedRowKey([{rowKey: undefined}, {rowKey: undefined}])).toBeUndefined();
  });

  it('does not let an earlier owner override a later owner', () => {
    expect(resolveFocusedRowKey([{rowKey: 'first'}, {rowKey: 'last'}])).toBe('last');
  });
});
