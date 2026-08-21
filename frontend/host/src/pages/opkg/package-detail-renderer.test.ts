import {flushSync} from 'svelte';
import {SvelteMap} from 'svelte/reactivity';
import {afterEach, describe, expect, it} from 'vitest';
import type {PackageEntry, PackageInfo} from '../../services/opkg-client.js';
import type {CellContext} from '@mndw/ui';
import {packageDetailRenderer} from './package-detail-renderer.svelte.js';
import type {PackageDetailState} from './PackageDetailCell.svelte';

describe('packageDetailRenderer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

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
