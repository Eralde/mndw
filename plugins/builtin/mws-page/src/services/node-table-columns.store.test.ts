import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FakePluginStorage} from '../test-support/plugin-storage.fake';
import {SHARED_PLUGIN_STORAGE} from '../tokens';
import {NODE_TABLE_COLUMNS_KEY, NodeTableColumnsStore, OPTIONAL_NODE_COLUMN_IDS} from './node-table-columns.store';

function stored(columns: readonly string[], version = 1): string {
  return JSON.stringify({version, columns});
}

describe('NodeTableColumnsStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function makeStore(storage: FakePluginStorage): NodeTableColumnsStore {
    TestBed.configureTestingModule({
      providers: [
        NodeTableColumnsStore,
        {provide: SHARED_PLUGIN_STORAGE, useValue: storage},
      ],
    });

    return TestBed.inject(NodeTableColumnsStore);
  }

  it('loads valid optional columns and ignores unknown IDs', async () => {
    const storage = new FakePluginStorage({
      values: {[NODE_TABLE_COLUMNS_KEY]: stored(['clients', 'unknown', 'connection'])},
    });
    const store = makeStore(storage);

    await store.load();

    expect([...store.visibleColumns()]).toEqual(['clients', 'connection']);
  });

  it('falls back to every optional column for malformed or unknown versions', async () => {
    const malformed = makeStore(
      new FakePluginStorage({
        values: {[NODE_TABLE_COLUMNS_KEY]: '{not-json'},
      }),
    );

    await malformed.load();
    expect([...malformed.visibleColumns()]).toEqual([...OPTIONAL_NODE_COLUMN_IDS]);

    TestBed.resetTestingModule();

    const wrongVersion = makeStore(
      new FakePluginStorage({
        values: {[NODE_TABLE_COLUMNS_KEY]: stored(['clients'], 2)},
      }),
    );

    await wrongVersion.load();
    expect([...wrongVersion.visibleColumns()]).toEqual([...OPTIONAL_NODE_COLUMN_IDS]);
  });

  it('updates visibility immediately and persists only optional column IDs', async () => {
    const storage = new FakePluginStorage();
    const store = makeStore(storage);

    store.setVisible('clients', false);
    await store.flush();

    expect(store.visibleColumns().has('clients')).toBe(false);
    expect(JSON.parse(storage.read(NODE_TABLE_COLUMNS_KEY) ?? '{}')).toEqual({
      version: 1,
      columns: OPTIONAL_NODE_COLUMN_IDS.filter((id) => id !== 'clients'),
    });
  });
});
