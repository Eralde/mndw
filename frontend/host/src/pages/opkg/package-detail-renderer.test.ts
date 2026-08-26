import {flushSync} from 'svelte';
import {SvelteMap} from 'svelte/reactivity';
import {afterEach, describe, expect, it} from 'vitest';
import type {PackageEntry, PackageInfo} from '../../services/opkg-client.js';
import type {CellContext} from '@mndw/ui';
import {packageDetailRenderer} from './package-detail-renderer.svelte.js';
import type {PackageDetailState} from './PackageDetailCell.svelte';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('packageDetailRenderer cache', () => {
  it('reuses cached success after a renderer is destroyed and remounted', () => {
    const cache = new SvelteMap<string, PackageDetailState>();
    const row: PackageEntry = {
      name: 'x',
      version: '1',
      description: 'summary',
      status: 'installed',
    };
    const info: PackageInfo = {
      ...row,
      dependencies: [],
    };
    let requests = 0;
    const load = (name: string): void => {
      if (cache.has(name)) {
        return;
      }

      requests += 1;
      cache.set(name, {status: 'success', info});
    };
    const rendererFactory = packageDetailRenderer({cache, load, retry: (): void => {}});
    const context = (node: HTMLElement): CellContext<PackageEntry, PackageEntry> => ({
      node,
      row,
      value: row,
      colId: '__mndw_detail__',
    });
    const firstNode = document.createElement('div');
    const first = rendererFactory();

    first.mount(context(firstNode));
    flushSync();
    expect(firstNode.textContent).toContain('summary');
    first.destroy();

    const secondNode = document.createElement('div');
    const second = rendererFactory();

    second.mount(context(secondNode));
    flushSync();

    expect(secondNode.textContent).toContain('summary');
    expect(requests).toBe(1);
    second.destroy();
  });
});

describe('packageDetailRenderer updates', () => {
  it('updates value and colId in place without remounting', () => {
    const cache = new SvelteMap<string, PackageDetailState>();
    const first: PackageEntry = {
      name: 'first',
      version: '1',
      description: 'first description',
      status: 'installed',
    };
    const second: PackageEntry = {
      name: 'second',
      version: '2',
      description: 'second description',
      status: 'installed',
    };

    cache.set('first', {status: 'success', info: {...first, dependencies: []}});
    cache.set('second', {status: 'success', info: {...second, dependencies: []}});

    const renderer = packageDetailRenderer({
      cache,
      load: () => {},
      retry: () => {},
    })();
    const node = document.createElement('div');

    renderer.mount({node, row: first, value: first, colId: 'first'});
    flushSync();

    const detail = node.querySelector('.detail');

    renderer.update({node, row: second, value: second, colId: 'second'});
    flushSync();

    expect(node.querySelector('.detail')).toBe(detail);
    expect(detail?.getAttribute('data-package')).toBe('second');
    expect(detail?.getAttribute('data-col')).toBe('second');
    expect(detail?.textContent).toContain('second description');
    renderer.destroy();
  });
});
