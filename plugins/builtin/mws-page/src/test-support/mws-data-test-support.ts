import {TestBed} from '@angular/core/testing';
import type {BackendClient, HostInfo} from '@mndw/sdk';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {MwsApiService, type MwsMemberResult} from '../api/mws-api.service';
import {normalizeBridge, normalizeDeviceHosts, normalizeMembers, normalizeVersion} from '../api/normalize';
import type {MwsNode} from '../domain/mws/mws.types';
import {loadFixture} from '../fixtures/load';
import {HOST_INFO, MWSD_BACKEND, MWS_MOCK_OPTIONS, type MwsMockOptions} from '../tokens';
import {MwsDataService} from '../services/mws-data.service';
import {MwsMockDataService} from '../services/mws-mock-data.service';

export interface FakeApi {
  readonly showVersion: ReturnType<typeof vi.fn>;
  readonly showMwsMember: ReturnType<typeof vi.fn>;
  readonly showDeviceList: ReturnType<typeof vi.fn>;
  readonly showBridge0: ReturnType<typeof vi.fn>;
  readonly showControllerDescription: ReturnType<typeof vi.fn>;
}

export const HOST: HostInfo = {
  deviceName: 'My Router',
  vendor: 'Keenetic',
  firmwareVersion: '5.1.1',
  theme: 'light',
};

export function goodApi(): FakeApi {
  return {
    showVersion: vi.fn(() => of(normalizeVersion(loadFixture('show-version.json')))),
    showMwsMember: vi.fn(() =>
      of<MwsMemberResult>({kind: 'ok', members: normalizeMembers(loadFixture('show-mws-member.json'))})
    ),
    showDeviceList: vi.fn(() => of(normalizeDeviceHosts(loadFixture('show-device-list.json')))),
    showBridge0: vi.fn(() => of(normalizeBridge(loadFixture('show-interface-bridge0.json')))),
    showControllerDescription: vi.fn(() => of(HOST.deviceName)),
  };
}

export function makeLiveService(api: FakeApi): MwsDataService {
  return makeLiveServiceWithBackend(api, null);
}

export function makeLiveServiceWithBackend(api: FakeApi, backend: BackendClient | null): MwsDataService {
  TestBed.configureTestingModule({
    providers: [
      MwsDataService,
      {provide: MwsApiService, useValue: api as unknown as MwsApiService},
      {provide: HOST_INFO, useValue: HOST},
      {provide: MWSD_BACKEND, useValue: backend},
    ],
  });

  return TestBed.inject(MwsDataService);
}

export function fakeBackend(fetch: BackendClient['fetch'], status?: BackendClient['status']): BackendClient {
  const backend = {fetch, socket: vi.fn()} as unknown as BackendClient;

  if (status !== undefined) {
    backend.status = status;
  }

  return backend;
}

export function makeMockService(
  api: FakeApi,
  mockOptions: MwsMockOptions,
  backend: BackendClient | null = null,
): MwsMockDataService {
  TestBed.configureTestingModule({
    providers: [
      MwsMockDataService,
      {provide: MwsApiService, useValue: api as unknown as MwsApiService},
      {provide: HOST_INFO, useValue: HOST},
      {provide: MWSD_BACKEND, useValue: backend},
      {provide: MWS_MOCK_OPTIONS, useValue: mockOptions},
    ],
  });

  return TestBed.inject(MwsMockDataService);
}

export function countNodes(roots: MwsNode[]): number {
  return roots.reduce((count, node) => count + 1 + countNodes(node.children.map((link) => link.node)), 0);
}

export function countClients(roots: MwsNode[]): number {
  return roots.reduce(
    (count, node) => count + node.clients.length + countClients(node.children.map((link) => link.node)),
    0,
  );
}
