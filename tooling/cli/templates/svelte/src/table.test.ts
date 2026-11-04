// @vitest-environment happy-dom

import {flushSync} from 'svelte';
import {defineMndwUi} from '@mndw/ui';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {createInstance} from './index.js';

type TableElement = HTMLElement & {updateComplete: Promise<unknown>};

const catalog = {
  table: {
    caption: 'Example records',
    column: 'Name',
    first: 'Alpha',
    second: 'Beta',
  },
};

defineMndwUi();

afterEach(() => {
  document.body.innerHTML = '';
});

describe('generated Svelte table', () => {
  it('renders localized rows through svelteCell', async () => {
    const fixture = createTestPluginContext({i18n: createTestI18n(catalog)});
    const container = document.createElement('div');
    document.body.append(container);
    const instance = createInstance(container, fixture.context);
    flushSync();

    const table = container.querySelector('mndw-table') as TableElement | null;

    if (table === null) {
      throw new Error('expected generated mndw-table');
    }

    await table.updateComplete;
    expect(table.shadowRoot?.querySelectorAll('[part="row"]')).toHaveLength(2);
    expect(table.shadowRoot?.querySelector('[part="caption"]')?.textContent).toBe(catalog.table.caption);
    expect(table.shadowRoot?.querySelector('[part="header-cell"]')?.textContent).toContain(catalog.table.column);
    expect(Array.from(table.querySelectorAll('[data-testid="table-name-cell"]')).map((cell) => cell.textContent))
      .toEqual([
        catalog.table.first,
        catalog.table.second,
      ]);

    instance.unmount();
    fixture.unmount();
  });
});
