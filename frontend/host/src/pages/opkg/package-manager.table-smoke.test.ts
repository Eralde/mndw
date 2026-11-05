// @vitest-environment happy-dom
import {svelteCell} from '@mndw/ui-svelte';
import {flushSync} from 'svelte';
import {afterEach, describe, expect, it} from 'vitest';
import type {PackageEntry} from '../../services/opkg-client.js';
import PackageNameCell from './PackageNameCell.svelte';
import packageManagerSource from './PackageManager.svelte?raw';
import packagesPanelSource from './PackagesPanel.svelte?raw';
import servicesPanelSource from './ServicesPanel.svelte?raw';

const installed: PackageEntry = {
  name: 'installed',
  version: '1.0.0',
  status: 'installed',
  description: 'Installed package',
};

const update: PackageEntry = {
  name: 'update',
  version: '1.0.0',
  newVersion: '2.0.0',
  status: 'update_available',
  description: 'Update package',
};

const parkedNodes: HTMLElement[] = [];

afterEach(() => {
  for (const node of parkedNodes.splice(0)) {
    node.remove();
  }
});

describe('PackageNameCell through svelteCell', () => {
  it('renders the package name and updates reactively on same-key row replacement', () => {
    const node = document.createElement('div');

    document.body.appendChild(node);
    parkedNodes.push(node);

    const renderer = svelteCell<PackageEntry, string>()(PackageNameCell)();

    renderer.mount({node, row: installed, value: installed.name, colId: 'name'});
    expect(node.textContent).toContain('installed');

    renderer.update({node, row: update, value: update.name, colId: 'name'});
    flushSync();

    const span = node.querySelector('span.package-name');

    expect(span?.textContent).toBe('update');
    expect(span?.getAttribute('title')).toBe('update');
    expect(span?.className).toContain('svelte-');

    renderer.destroy();

    expect(node.textContent).toBe('');
  });
});

describe('table scroll-owner contract', () => {
  it('keeps package and service controls outside their table viewports', () => {
    expect(packageManagerSource).toContain('mndw-table-controls');
    expect(packagesPanelSource).toContain('mndw-table-controls');
    expect(packagesPanelSource).toContain('mndw-table::part(viewport)');
    expect(servicesPanelSource).toContain('mndw-table-controls');
    expect(servicesPanelSource).toContain('mndw-table::part(viewport)');
  });
});
