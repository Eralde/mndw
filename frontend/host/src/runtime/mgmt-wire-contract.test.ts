import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {decodeMgmtList, decodeMgmtListEntry, mgmtWireEnumSchemas} from './mgmt-list-schema.js';

const readFixture = (name: string): unknown => {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'src/runtime/fixtures/mgmt', name), 'utf8')) as unknown;
};

describe('management wire contract', () => {
  it.each(['list.json', 'pending.json'])('decodes %s losslessly', (name) => {
    const fixture = readFixture(name) as {plugins: unknown[]};

    // Zod strips unknown keys, so equality proves every daemon field is modelled.
    expect(decodeMgmtList(fixture)).toEqual(fixture.plugins);
  });

  it('decodes the permission mutation response losslessly', () => {
    const fixture = readFixture('permission-entry.json');

    expect(decodeMgmtListEntry(fixture)).toEqual(fixture);
  });

  it('keeps event declarations out of permission grants in the golden corpus', () => {
    const entry = decodeMgmtListEntry(readFixture('permission-entry.json'));

    expect(entry.permissions).toContain('events:wan');
    expect(Object.keys(entry.permissionGrants ?? {})).not.toContain('events:wan');
  });

  it('pins wire enums to the shared contract', () => {
    const enums = readFixture('enums.json') as Record<keyof typeof mgmtWireEnumSchemas, string[]>;

    expect(mgmtWireEnumSchemas.source.options).toEqual(enums.source);
    expect(mgmtWireEnumSchemas.approval.options).toEqual(enums.approval);
    expect(mgmtWireEnumSchemas.depsStatus.options).toEqual(enums.depsStatus);
    expect(mgmtWireEnumSchemas.runtimeState.options).toEqual(enums.runtimeState);
  });
});
