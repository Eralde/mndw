import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {createTestI18n} from '@mndw/sdk/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import type {MwsClient, MwsNode} from '../../domain/mws/mws.types';
import {MwsClientsTableComponent} from './clients-table.component';
import tableStyles from './clients-table.component.scss?raw';
import tableTemplate from './clients-table.component.html?raw';
import {TRANSLATOR} from '../../tokens';
import enCatalog from '../../../i18n/en.json';

function client(mac: string, name: string, ip: string | null, uptime: number | null, wired: boolean): MwsClient {
  return {mac, name, ip, uptime, lastSeen: null, wired};
}

function node(id: string, name: string, clients: MwsClient[] = []): MwsNode {
  return {
    id,
    cid: null,
    name,
    model: null,
    ip: null,
    mac: id,
    isController: false,
    isOnline: true,
    fw: null,
    fwAvailable: null,
    system: null,
    backhaul: null,
    parent: null,
    children: [],
    clients,
  };
}

function fixtureRoots(): MwsNode[] {
  return [
    node('node-a', 'Node A', [
      client('client-1', 'Beta', '10.0.0.2', 20, false),
      client('client-2', 'Alpha', '10.0.0.10', null, true),
    ]),
    node('node-b', 'Node B', [client('client-3', 'Gamma', null, 30, false)]),
  ];
}

function tableRows(
  fixture: ReturnType<typeof TestBed.createComponent<MwsClientsTableComponent>>,
): HTMLTableRowElement[] {
  return [...fixture.nativeElement.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

function render(roots: MwsNode[]): ReturnType<typeof TestBed.createComponent<MwsClientsTableComponent>> {
  const fixture = TestBed.createComponent(MwsClientsTableComponent);

  fixture.componentRef.setInput('roots', roots);
  fixture.detectChanges();

  return fixture;
}

describe('MwsClientsTableComponent', () => {
  beforeEach(async () => {
    TestBed.resetTestingModule();
    await resolveComponentResources((url: string) => {
      if (url.endsWith('clients-table.component.html')) {
        return Promise.resolve(tableTemplate);
      }

      if (url.endsWith('clients-table.component.scss')) {
        return Promise.resolve(tableStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [MwsClientsTableComponent],
      providers: [{provide: TRANSLATOR, useValue: createTestI18n(enCatalog)}],
    }).compileComponents();
  });

  it('renders one row per client and accessible sortable headers', () => {
    const fixture = render(fixtureRoots());

    const element = fixture.nativeElement as HTMLElement;
    const headers = [...element.querySelectorAll<HTMLTableCellElement>('th[scope="col"]')];

    expect(tableRows(fixture)).toHaveLength(3);
    expect(headers).toHaveLength(6);
    expect(headers.every((header) => header.querySelector('button[type="button"]') !== null)).toBe(true);
    expect(headers[0]?.getAttribute('aria-sort')).toBe('ascending');
    expect(headers.slice(1).every((header) => header.getAttribute('aria-sort') === 'none')).toBe(true);
    expect(tableRows(fixture)[0]?.textContent).toContain('Alpha');
    expect(tableRows(fixture)[0]?.textContent).toContain('Node A');
  });

  it('filters rows from the mndwinput event value', () => {
    const fixture = render(fixtureRoots());

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
    expect(tableRows(fixture)[0]?.textContent).toContain('Gamma');
  });

  it('sorts by a new header and toggles direction on the active header', () => {
    const fixture = render(fixtureRoots());

    const headers = [...fixture.nativeElement.querySelectorAll<HTMLTableCellElement>('th[scope="col"]')];
    const nodeButton = headers[1]?.querySelector<HTMLButtonElement>('button');

    nodeButton?.click();
    fixture.detectChanges();

    expect(headers[1]?.getAttribute('aria-sort')).toBe('ascending');
    expect(headers[0]?.getAttribute('aria-sort')).toBe('none');
    expect(tableRows(fixture)[0]?.textContent).toContain('Node A');

    nodeButton?.click();
    fixture.detectChanges();

    expect(headers[1]?.getAttribute('aria-sort')).toBe('descending');
    expect(tableRows(fixture)[0]?.textContent).toContain('Node B');
  });

  it('rerenders rows when the signal input receives a new roots array', () => {
    const fixture = render(fixtureRoots());

    fixture.componentRef.setInput('roots', [
      node('node-c', 'Node C', [client('client-4', 'New Client', null, 1, true)]),
    ]);
    fixture.detectChanges();

    expect(tableRows(fixture)).toHaveLength(1);
    expect(tableRows(fixture)[0]?.textContent).toContain('New Client');
  });

  it('shows distinct empty mesh and no-match states', () => {
    const emptyFixture = render([]);

    expect((emptyFixture.nativeElement as HTMLElement).textContent).toContain('No clients connected.');

    const filteredFixture = render(fixtureRoots());

    filteredFixture.nativeElement.querySelector<HTMLElement>('mndw-input')?.dispatchEvent(
      new CustomEvent('mndwinput', {detail: {value: 'does-not-exist'}, bubbles: true, composed: true}),
    );
    filteredFixture.detectChanges();

    expect((filteredFixture.nativeElement as HTMLElement).textContent).toContain('No clients match your search.');
  });
});
