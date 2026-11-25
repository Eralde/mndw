import {flushSync, mount, settled, unmount} from 'svelte';
import {createTestI18n} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it} from 'vitest';
import enCatalog from '../../i18n/en.json';
import PageNotice from './PageNotice.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

afterEach(() => {
  if (app !== null) {
    void unmount(app);
    app = null;
  }

  host?.remove();
});

describe('PageNotice', () => {
  it('renders controller backend recovery notice', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = mount(PageNotice, {
      target: host,
      props: {notice: {kind: 'backend-recovered'}, i18n: createTestI18n(enCatalog)},
    });
    await settled();
    flushSync();

    expect(host.querySelectorAll('[data-testid="page-notice"]')).toHaveLength(1);
    expect(host.textContent).toContain('Backend available again after a temporary outage');
  });
});
