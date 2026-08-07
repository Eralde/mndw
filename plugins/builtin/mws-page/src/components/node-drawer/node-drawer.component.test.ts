import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {Subject, of, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeDeviceHosts, normalizeMembers} from '../../api/normalize';
import {buildMap, findNodeById} from '../../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../../domain/mws/mws.types';
import {loadFixture} from '../../fixtures/load';
import {MwsDataService} from '../../services/mws-data.service';
import {MWS_RENAME_API} from '../../tokens';
import drawerStyles from './node-drawer.component.scss?raw';
import drawerTemplate from './node-drawer.component.html?raw';
import {NodeDrawerComponent} from './node-drawer.component';

const CONTROLLER: ControllerInfo = {
  mac: '02:7d:4a:91:c3:10',
  ip: '192.168.1.1',
  name: 'Router',
  model: 'Hopper (KN-3811)',
  firmware: '5.2 Alpha 1',
  interfaceUptime: 3201,
  isOnline: true,
};

function roots(): MwsNode[] {
  return buildMap(
    normalizeMembers(loadFixture('show-mws-member.json')),
    normalizeDeviceHosts(loadFixture('show-device-list.json')),
    CONTROLLER,
  );
}

describe('NodeDrawerComponent', () => {
  let renameNode: ReturnType<typeof vi.fn>;
  let refreshNow: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    renameNode = vi.fn(() => of(undefined));
    refreshNow = vi.fn();
    await resolveComponentResources((url: string) => {
      if (url.endsWith('node-drawer.component.html')) {
        return Promise.resolve(drawerTemplate);
      }

      if (url.endsWith('node-drawer.component.scss')) {
        return Promise.resolve(drawerStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [NodeDrawerComponent],
      providers: [
        {provide: MWS_RENAME_API, useValue: {renameNode}},
        {provide: MwsDataService, useValue: {refreshNow}},
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders identity, wireless backhaul, and clients for an extender', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Mesh Extender A');
    expect(text).toContain('Buddy 6 (KN-3411)');
    expect(text).toContain('−35 dBm');
    expect(text).toContain('1.2 Gbit/s');
    expect(text).toContain('11ax');
  });

  it('renders wired backhaul details for the wired extender', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:32'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('1 Gbit/s');
    expect(text).toContain('full');
  });

  it('labels the controller and lists its directly-attached clients', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Controller');
    expect(text).toContain('Client A');
  });

  it('renders em dashes for missing values and an offline state for null', () => {
    const offlineOnly = buildMap(normalizeMembers([{cid: 'c1', mac: 'aa:00:00:00:00:01'}]), [], CONTROLLER);
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(offlineOnly, 'aa:00:00:00:00:01'));
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('—');

    fixture.componentRef.setInput('node', null);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('no longer reported');
  });

  it('submits a trimmed controller name and updates the title without mutating the node', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:10');
    const setTitle = vi.fn();
    const renamed = vi.fn();

    fixture.componentRef.setInput('node', node);
    fixture.componentRef.setInput('setTitle', setTitle);
    fixture.componentInstance.renamed.subscribe(renamed);
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = '  Renamed Router  ';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
    fixture.detectChanges();

    expect(renameNode).toHaveBeenCalledWith('02:7d:4a:91:c3:10', true, 'Renamed Router');
    expect(refreshNow).toHaveBeenCalledOnce();
    expect(setTitle).toHaveBeenCalledWith('Renamed Router');
    expect(renamed).toHaveBeenCalledWith('Renamed Router');
    expect(node?.name).toBe('Router');
  });

  it('uses the extender rename path through the injected port', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput('node', node);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = 'Renamed Extender';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    fixture.nativeElement.querySelector<HTMLElement>('[data-action="save-name"]')?.click();
    fixture.detectChanges();

    expect(renameNode).toHaveBeenCalledWith('02:7d:4a:91:c3:21', false, 'Renamed Extender');
  });

  it('shows local validation errors without calling the API', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = '   ';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    fixture.nativeElement.querySelector<HTMLElement>('[data-action="save-name"]')?.click();
    fixture.detectChanges();

    expect(renameNode).not.toHaveBeenCalled();
    expect(refreshNow).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Name cannot be empty.');
    expect(fixture.nativeElement.querySelector('mndw-input')).not.toBeNull();
  });

  it('cancels on Escape and keeps Save disabled while a write is pending', () => {
    const pending = new Subject<void>();

    renameNode.mockReturnValue(pending);

    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = 'Pending name';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
    fixture.detectChanges();

    expect(
      (fixture.nativeElement.querySelector<HTMLElement & {disabled: boolean}>('[data-action="save-name"]'))?.disabled,
    ).toBe(true);
    expect((fixture.nativeElement.querySelector<HTMLElement & {disabled: boolean}>('mndw-input'))?.disabled).toBe(true);

    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, composed: true}));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mndw-input')).not.toBeNull();

    pending.next();
    pending.complete();
  });

  it('keeps entered text and renders a device error after a failed write', () => {
    renameNode.mockReturnValue(throwError(() => new Error('Name rejected by device')));

    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = 'Rejected name';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    fixture.nativeElement.querySelector<HTMLElement>('[data-action="save-name"]')?.click();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Name rejected by device');
    expect(fixture.nativeElement.querySelector('mndw-input')).not.toBeNull();
    expect((fixture.nativeElement.querySelector('mndw-input') as HTMLElement & {value: string}).value).toBe(
      'Rejected name',
    );
  });
});
