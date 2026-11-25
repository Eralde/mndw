import {readFileSync} from 'node:fs';
import {flushSync, mount, settled, unmount} from 'svelte';
import {createTestI18n} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it} from 'vitest';
import enCatalog from '../../i18n/en.json';
import type {Snapshot} from '../model/api';
import Diagnostics from './Diagnostics.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

async function render(update: (snapshot: Snapshot) => void = () => {}): Promise<Array<[string, string]>> {
  const snapshot = JSON.parse(readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8')) as Snapshot;

  update(snapshot);
  host = document.createElement('div');
  document.body.append(host);
  app = mount(Diagnostics, {target: host, props: {snapshot, i18n: createTestI18n(enCatalog), locale: 'en'}});
  await settled();
  flushSync();

  return [...host.querySelectorAll('dt')].map((term) => {
    return [term.textContent ?? '', (term.nextElementSibling?.textContent ?? '').trim()];
  });
}

afterEach(() => {
  if (app !== null) {
    void unmount(app);
    app = null;
  }

  host?.remove();
});

describe('Diagnostics', () => {
  it('shows the utility state, path and version as separate rows', async () => {
    const rows = await render();

    expect(rows.filter(([term]) => ['S.M.A.R.T. utility', 'Path', 'Version'].includes(term))).toEqual([
      ['S.M.A.R.T. utility', 'Available'],
      ['Path', '/opt/sbin/smartctl'],
      ['Version', 'smartctl 7.5'],
    ]);
  });

  it('omits the path and version rows when the backend reports none', async () => {
    const rows = await render((snapshot) => {
      snapshot.diagnostics.utility = {available: false, path: null, version: null};
    });

    expect(rows.map(([term]) => term)).not.toContain('Path');
    expect(rows.map(([term]) => term)).not.toContain('Version');
    expect(rows).toContainEqual(['S.M.A.R.T. utility', 'Unavailable']);
  });
});
