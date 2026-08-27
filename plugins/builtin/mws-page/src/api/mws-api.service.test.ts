import {TestBed} from '@angular/core/testing';
import type {RciManager} from '@rci-tools/core';
import {firstValueFrom, of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {loadFixture} from '../fixtures/load';
import {RCI_MANAGER} from '../tokens';
import {MwsApiParseError} from './normalize';
import {MwsApiService, isUnsupportedMwsMemberResponse} from './mws-api.service';

function serviceWith(queue: (query: unknown) => unknown): {service: MwsApiService; queue: ReturnType<typeof vi.fn>} {
  const queueMock = vi.fn(queue);

  TestBed.configureTestingModule({
    providers: [MwsApiService, {provide: RCI_MANAGER, useValue: {queue: queueMock} as unknown as RciManager}],
  });

  return {service: TestBed.inject(MwsApiService), queue: queueMock};
}

describe('MwsApiService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('queries show.mws.member and normalizes members', async () => {
    const {service, queue} = serviceWith(() => of(loadFixture('show-mws-member.json')));
    const result = await firstValueFrom(service.showMwsMember());

    expect(queue).toHaveBeenCalledWith({path: 'show.mws.member'});

    if (result.kind !== 'ok') {
      throw new Error('expected ok');
    }

    expect(result.members).toHaveLength(2);
    expect(result.members[0].mac).toBe('02:7d:4a:91:c3:21');
  });

  it('treats an empty show.mws.member object as no members', async () => {
    const {service} = serviceWith(() => of({}));

    await expect(firstValueFrom(service.showMwsMember())).resolves.toEqual({kind: 'ok', members: []});
  });

  it('classifies the pinned unsupported response', async () => {
    const {service} = serviceWith(() => of(loadFixture('show-mws-member-unsupported.json')));

    expect(await firstValueFrom(service.showMwsMember())).toEqual({kind: 'unsupported'});
  });

  it('does not classify other status errors as unsupported', () => {
    expect(isUnsupportedMwsMemberResponse({status: [{status: 'error', code: '1179781'}]})).toBe(false);
    expect(isUnsupportedMwsMemberResponse({
      status: [{status: 'error', code: '7405600', ident: 'Core::Configurator'}],
    })).toBe(false);
    expect(isUnsupportedMwsMemberResponse(null)).toBe(false);
    expect(isUnsupportedMwsMemberResponse([])).toBe(false);
  });

  it('throws MwsApiParseError for a malformed member response', async () => {
    const {service} = serviceWith(() => of({nonsense: true}));

    await expect(firstValueFrom(service.showMwsMember())).rejects.toBeInstanceOf(MwsApiParseError);
  });

  it('queries show.device-list, show.interface Bridge0, and show.version', async () => {
    const responses: Record<string, unknown> = {
      'show.device-list': loadFixture('show-device-list.json'),
      'show.interface': loadFixture('show-interface-bridge0.json'),
      'show.version': loadFixture('show-version.json'),
    };
    const {service, queue} = serviceWith((query) => of(responses[(query as {path: string}).path]));

    expect(await firstValueFrom(service.showDeviceList())).toHaveLength(1);
    expect((await firstValueFrom(service.showBridge0())).mac).toBe('02:7d:4a:91:c3:10');
    expect((await firstValueFrom(service.showVersion())).model).toBe('Hopper (KN-3811)');
    expect(queue).toHaveBeenCalledWith({path: 'show.interface', data: {name: 'Bridge0'}});
  });

  it('queries and normalizes the controller name from show.version.description', async () => {
    const {service, queue} = serviceWith(() => of({description: 'Router'}));

    await expect(firstValueFrom(service.showControllerDescription())).resolves.toBe('Router');
    expect(queue).toHaveBeenCalledWith({path: 'show.version'});
  });

  it('renames a controller with the system.description RCI path', async () => {
    const {service, queue} = serviceWith(() => of({status: [{status: 'ok'}]}));

    await expect(firstValueFrom(service.renameNode('02:7d:4a:91:c3:10', true, '  New Router  '))).resolves
      .toBeUndefined();

    expect(queue).toHaveBeenCalledWith({path: 'system.description', data: 'New Router'});
  });

  it('renames an extender with the normalized known.host payload', async () => {
    const {service, queue} = serviceWith(() => of({status: [{status: 'ok'}]}));

    await expect(firstValueFrom(service.renameNode(' 02:7D:4A:91:C3:21 ', false, '  New Extender '))).resolves
      .toBeUndefined();

    expect(queue).toHaveBeenCalledWith({
      path: 'known.host',
      data: {mac: '02:7d:4a:91:c3:21', name: 'New Extender'},
    });
  });

  it('rejects invalid names without queueing an RCI write', async () => {
    const {service, queue} = serviceWith(() => of({status: [{status: 'ok'}]}));

    await expect(firstValueFrom(service.renameNode('02:7d:4a:91:c3:10', true, '   '))).rejects.toThrow(
      'Name cannot be empty.',
    );
    await expect(firstValueFrom(service.renameNode('02:7d:4a:91:c3:10', true, 'a'.repeat(65)))).rejects.toThrow(
      'Name must be 64 characters or fewer.',
    );
    expect(queue).not.toHaveBeenCalled();
  });

  it('maps an RCI status error to its device message', async () => {
    const {service} = serviceWith(() => of({status: [{status: 'error', message: 'Name is reserved'}]}));

    await expect(firstValueFrom(service.renameNode('02:7d:4a:91:c3:10', true, 'Router'))).rejects.toThrow(
      'Name is reserved',
    );
  });
});
