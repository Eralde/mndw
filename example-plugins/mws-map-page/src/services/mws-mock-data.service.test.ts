import {TestBed} from '@angular/core/testing';
import {countClients, countNodes, goodApi, makeMockService} from '../test-support/mws-data-test-support';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

describe('MwsMockDataService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('publishes generated data without calling RCI', () => {
    const api = goodApi();
    const service = makeMockService(api, {mode: 'large', extenders: 5, clients: 17});

    service.start();

    expect(service.phase()).toBe('ready');
    expect(countNodes(service.roots())).toBe(6);
    expect(countClients(service.roots())).toBe(17);
    expect(api.showVersion).not.toHaveBeenCalled();
    expect(api.showMwsMember).not.toHaveBeenCalled();
    expect(api.showDeviceList).not.toHaveBeenCalled();
    expect(api.showBridge0).not.toHaveBeenCalled();
  });
});
