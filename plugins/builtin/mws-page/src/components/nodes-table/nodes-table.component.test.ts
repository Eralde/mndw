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
  };
}

function roots(): MwsNode[] {
  return [node('node-a', 'Node A', [node('node-b', 'Node B')])];
}

function tableRows(
  fixture: ReturnType<typeof TestBed.createComponent<MwsNodesTableComponent>>,
): HTMLTableRowElement[] {
  return [...fixture.nativeElement.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

function render(
  value: MwsNode[],
): ReturnType<typeof TestBed.createComponent<MwsNodesTableComponent>> {
  const fixture = TestBed.createComponent(MwsNodesTableComponent);

  fixture.componentRef.setInput('roots', value);
  fixture.detectChanges();

  return fixture;
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

  it('renders the eight read-only columns and controller badge', () => {
    const fixture = render(roots());
    const element = fixture.nativeElement as HTMLElement;
    const headers = [...element.querySelectorAll<HTMLTableCellElement>('th[scope="col"]')];

    expect(headers).toHaveLength(8);
    expect(headers.map((header) => header.textContent?.trim())).toEqual([
      'Node name',
      'Clients',
      'Status',
      'Uptime',
      'IP address',
      'Via',
      'Connection',
      'KeeneticOS',
    ]);
    expect(tableRows(fixture)).toHaveLength(2);
    expect(tableRows(fixture)[0]?.textContent).toContain('Controller');
    expect(element.textContent).not.toContain('Alert');
  });

  it('emits node ID from the Node name activation button', () => {
    const fixture = render(roots());
    const activated: string[] = [];

    fixture.componentInstance.nodeActivated.subscribe((id) => activated.push(id));
    fixture.nativeElement.querySelector<HTMLButtonElement>('tbody td.node-name button')?.click();

    expect(activated).toEqual(['node-a']);
  });

  it('filters by node name and sorts only on explicit header interaction', () => {
    const fixture = render(roots());
    const input = fixture.nativeElement.querySelector<HTMLElement>('mndw-input');

    input?.dispatchEvent(
      new CustomEvent('mndwinput', {
        detail: {value: 'node b'},
        bubbles: true,
        composed: true,
      }),
    );
    fixture.detectChanges();

    expect(tableRows(fixture)).toHaveLength(1);
    expect(tableRows(fixture)[0]?.textContent).toContain('Node B');

    input?.dispatchEvent(
      new CustomEvent('mndwinput', {
        detail: {value: ''},
        bubbles: true,
        composed: true,
      }),
    );
    fixture.detectChanges();

    const clientsHeader = fixture.nativeElement.querySelector<HTMLTableCellElement>('th.clients');

    clientsHeader?.querySelector<HTMLButtonElement>('button')?.click();
    fixture.detectChanges();

    expect(clientsHeader?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('opens table settings and hides optional columns without hiding Node name', () => {
    const fixture = render(roots());
    const element = fixture.nativeElement as HTMLElement;

    element.querySelector<HTMLElement>('mndw-button[aria-label="Table settings"]')?.click();
    fixture.detectChanges();

    expect(element.querySelector('[role="dialog"][aria-label="Table settings"]')).not.toBeNull();
    expect(element.querySelectorAll('mndw-switch')).toHaveLength(7);

    element.querySelector<HTMLElement>('#mws-node-column-clients')?.dispatchEvent(
      new CustomEvent('mndwchange', {detail: {checked: false}, bubbles: true, composed: true}),
    );
    fixture.detectChanges();

    expect(element.querySelector('th.clients')).toBeNull();
    expect(element.querySelector('th.name')).not.toBeNull();
  });

  it('resets sorting to Node name when hiding the active sort column', () => {
    const fixture = render(roots());
    const element = fixture.nativeElement as HTMLElement;

    element.querySelector<HTMLButtonElement>('th.clients button')?.click();
    fixture.detectChanges();
    element.querySelector<HTMLElement>('mndw-button[aria-label="Table settings"]')?.click();
    fixture.detectChanges();
    element.querySelector<HTMLElement>('#mws-node-column-clients')?.dispatchEvent(
      new CustomEvent('mndwchange', {detail: {checked: false}, bubbles: true, composed: true}),
    );
    fixture.detectChanges();

    expect(element.querySelector('th.name')?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('keeps Node name header and cells identifiable for sticky styling', () => {
    const fixture = render(roots());

    expect(fixture.nativeElement.querySelector('th.name')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('td.node-name')).not.toBeNull();
  });
});
