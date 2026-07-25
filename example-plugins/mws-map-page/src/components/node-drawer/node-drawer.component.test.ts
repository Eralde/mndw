import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {normalizeDeviceHosts, normalizeMembers} from '../../api/normalize';
import {buildMap, findNodeById} from '../../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../../domain/mws/mws.types';
import {loadFixture} from '../../fixtures/load';
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
  beforeEach(async () => {
    TestBed.resetTestingModule();
    await resolveComponentResources((url: string) => {
      if (url.endsWith('node-drawer.component.html')) {
        return Promise.resolve(drawerTemplate);
      }

      if (url.endsWith('node-drawer.component.scss')) {
        return Promise.resolve(drawerStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({imports: [NodeDrawerComponent]}).compileComponents();
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
    expect(text).toContain('-35');
    expect(text).toContain('11ax');
  });

  it('renders wired backhaul details for the wired extender', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:32'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('1000');
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
});
