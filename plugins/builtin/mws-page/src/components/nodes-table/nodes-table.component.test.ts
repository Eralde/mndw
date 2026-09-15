import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {createTestI18n} from '@mndw/sdk/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import type {MwsNode} from '../../domain/mws/mws.types';
import {FakePluginStorage} from '../../test-support/plugin-storage.fake';
import {SHARED_PLUGIN_STORAGE, TRANSLATOR} from '../../tokens';
import {NodeTableColumnsStore} from '../../services/node-table-columns.store';
import tableStyles from './nodes-table.component.scss?raw';
import tableTemplate from './nodes-table.component.html?raw';
import {MwsNodesTableComponent} from './nodes-table.component';
import enCatalog from '../../../i18n/en.json';

function node(id: string, name: string, children: MwsNode[] = []): MwsNode {
  return {
    id,
    cid: null,
    name,
    model: null,
    ip: id === 'node-a' ? '10.0.0.2' : null,
    mac: id,
    isController: id === 'node-a',
    isOnline: true,
    fw: '5.2',
    fwAvailable: null,
    system: {cpuload: null, memoryUsed: null, memoryTotal: null, uptime: 120},
    backhaul: {
      uplink: null,
      bridge: null,
      ap: null,
      rssi: -52,
      txrate: 866,
      mode: '11ax',
      security: null,
      cost: null,
      speed: null,
      duplex: null,
      portLabel: null,
    },
    parent: null,
    children: children.map((child) => ({type: 'wireless', node: child})),
    clients: [],
    dualBand: true,
    hwId: null,
    ports: [],
    fwUpdateAvailable: false,
    fwUpdateSandboxes: [],
    wirelessBands: [],
  };
}

function roots(): MwsNode[] {
  return [node('node-a', 'Node A', [node('node-b', 'Node B')])];
}

interface TableElement extends HTMLElement {
  shadowRoot: ShadowRoot;
  updateComplete: Promise<unknown>;
}

function tableOf(fixture: ReturnType<typeof TestBed.createComponent<MwsNodesTableComponent>>): TableElement {
  return fixture.nativeElement.querySelector('mndw-table') as TableElement;
}

function shadowRows(table: TableElement): HTMLTableRowElement[] {
  return [...table.shadowRoot.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

function render(
  value: MwsNode[],
): ReturnType<typeof TestBed.createComponent<MwsNodesTableComponent>> {
  const fixture = TestBed.createComponent(MwsNodesTableComponent);

  fixture.componentRef.setInput('roots', value);
  fixture.detectChanges();

  return fixture;
}

async function settle(table: TableElement): Promise<void> {
  await Promise.resolve();
  await table.updateComplete;
}

describe('MwsNodesTableComponent', () => {
  beforeEach(async () => {
    TestBed.resetTestingModule();
    await resolveComponentResources((url: string) => {
      if (url.endsWith('nodes-table.component.html')) {
        return Promise.resolve(tableTemplate);
      }

      if (url.endsWith('nodes-table.component.scss')) {
        return Promise.resolve(tableStyles);
      }

      throw new Error('resource URL: ' + url);
    });
    await TestBed.configureTestingModule({
      imports: [MwsNodesTableComponent],
      providers: [
        NodeTableColumnsStore,
        {provide: SHARED_PLUGIN_STORAGE, useValue: new FakePluginStorage()},
        {provide: TRANSLATOR, useValue: createTestI18n(enCatalog)},
      ],
    }).compileComponents();
  });

  it('renders the nine columns and controller badge in the shared table', async () => {
    const fixture = render(roots());
    const table = tableOf(fixture);
    const controls = fixture.nativeElement.querySelector('.mndw-table-controls');

    await settle(table);

    const headers = [...table.shadowRoot.querySelectorAll('th[scope="col"]')];

    expect(headers).toHaveLength(10);
    expect(table.shadowRoot.querySelector('tbody')?.textContent).toContain('Online');
    expect(table.querySelector('.node-name')?.textContent).toContain('Node A');
    expect(table.querySelector('.node-name')?.textContent).toContain('Controller');
    expect(controls).not.toBeNull();
    expect(controls?.contains(table)).toBe(false);
  });

  it('emits node ID from the Node name activation button', async () => {
    const fixture = render(roots());
    const table = tableOf(fixture);

    await settle(table);

    const activated: string[] = [];

    fixture.componentInstance.nodeActivated.subscribe((id) => activated.push(id));
    table.querySelector<HTMLButtonElement>('.node-name')?.click();

    expect(activated).toEqual(['node-a']);
  });

  it('formats uptime as human-readable text', async () => {
    const fixture = render(roots());
    const table = tableOf(fixture);

    await settle(table);

    const uptimeMarker = table.querySelector('[data-testid="uptime-cell"]');

    expect(uptimeMarker?.textContent?.trim()).toBe('2m');
  });

  it('filters by node name and sorts only on explicit header interaction', async () => {
    const fixture = render(roots());
    const table = tableOf(fixture);

    await settle(table);

    const input = fixture.nativeElement.querySelector<HTMLElement>('mndw-input');

    input?.dispatchEvent(
      new CustomEvent('mndwinput', {
        detail: {value: 'node b'},
        bubbles: true,
        composed: true,
      }),
    );
    fixture.detectChanges();
    await settle(table);

    expect(shadowRows(table)).toHaveLength(1);
    expect(table.querySelector('.node-name')?.textContent).toContain('Node B');

    input?.dispatchEvent(
      new CustomEvent('mndwinput', {
        detail: {value: ''},
        bubbles: true,
        composed: true,
      }),
    );
    fixture.detectChanges();
    await settle(table);

    const clientsButton = table.shadowRoot.querySelector<HTMLButtonElement>('button[data-sort-column="clients"]');

    clientsButton?.click();
    fixture.detectChanges();
    await settle(table);

    expect(table.shadowRoot.querySelector('th[aria-sort="ascending"]')?.textContent).toContain('Clients');
  });

  it('hides optional columns through the column menu without hiding Node name', async () => {
    const fixture = render(roots());
    const table = tableOf(fixture);

    await settle(table);

    table.shadowRoot.querySelector<HTMLButtonElement>('[part="column-menu-trigger"]')?.click();
    await settle(table);

    const menu = document.querySelector('mndw-column-menu') as unknown as TableElement | null;

    expect(menu).not.toBeNull();
    await menu?.updateComplete;

    const options = menu?.shadowRoot.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]');

    expect(options).toHaveLength(8);

    menu?.shadowRoot.querySelector<HTMLButtonElement>('button[data-column-id="clients"]')?.click();
    fixture.detectChanges();
    await settle(table);

    expect(table.shadowRoot.querySelector('button[data-sort-column="clients"]')).toBeNull();
    expect(table.shadowRoot.querySelector('button[data-sort-column="name"]')).not.toBeNull();
  });

  it('resets sorting to Node name when hiding the active sort column', async () => {
    const fixture = render(roots());
    const table = tableOf(fixture);

    await settle(table);

    table.shadowRoot.querySelector<HTMLButtonElement>('button[data-sort-column="clients"]')?.click();
    fixture.detectChanges();
    await settle(table);

    table.shadowRoot.querySelector<HTMLButtonElement>('[part="column-menu-trigger"]')?.click();
    await settle(table);

    const menu = document.querySelector('mndw-column-menu') as unknown as TableElement;

    await menu.updateComplete;
    menu.shadowRoot.querySelector<HTMLButtonElement>('button[data-column-id="clients"]')?.click();
    fixture.detectChanges();
    await settle(table);

    expect(table.shadowRoot.querySelector('th[aria-sort="ascending"]')?.textContent).toContain('Node name');
  });
});
