import type {RciManager, RciQuery} from '@rci-tools/core';
import {Observable, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {DeviceRciStatusError, createDeviceDescriptionApi, validateDescription} from './device-description.js';

interface Recorded<T> {
  readonly values: T[];
  readonly errors: unknown[];
  completed: boolean;
}

function record<T>(observable: Observable<T>): Recorded<T> {
  const result: Recorded<T> = {values: [], errors: [], completed: false};

  observable.subscribe({
    next: (value) => result.values.push(value),
    error: (error: unknown) => result.errors.push(error),
    complete: () => {
      result.completed = true;
    },
  });

  return result;
}

function fakeRci(handler: (query: RciQuery) => Observable<unknown>): RciManager {
  return {queue: vi.fn(handler)} as unknown as RciManager;
}

describe('createDeviceDescriptionApi', () => {
  it('reads show.version and trims a raw string response', () => {
    const queue = vi.fn(() => of('  Router name  '));
    const api = createDeviceDescriptionApi({queue} as unknown as RciManager);

    const result = record(api.read());

    expect(queue).toHaveBeenCalledWith({path: 'show.version'});
    expect(result.values).toEqual(['Router name']);
    expect(result.errors).toEqual([]);
    expect(result.completed).toBe(true);
  });

  it.each([
    ['object data', {data: '  Router data  '}, 'Router data'],
    ['description property', {description: '  Router description  '}, 'Router description'],
    ['data precedence', {data: 'Data wins', description: 'Description loses'}, 'Data wins'],
    ['null data fallback', {data: null, description: 'Fallback description'}, 'Fallback description'],
    ['empty data precedence', {data: 42, description: 'Do not use'}, ''],
    ['whitespace-only value', {description: '  \n  '}, ''],
    ['missing value', {}, ''],
    ['non-object value', 42, ''],
    ['undefined value', undefined, ''],
  ])('normalizes %s response', (_name, response, expected) => {
    const api = createDeviceDescriptionApi(fakeRci(() => of(response)));

    expect(record(api.read()).values).toEqual([expected]);
  });

  it.each([
    ['message', {message: 'message detail'}, 'message detail'],
    ['error', {error: 'error detail'}, 'error detail'],
    ['msg', {msg: 'msg detail'}, 'msg detail'],
    ['description', {description: 'description detail'}, 'description detail'],
    ['fallback', {}, 'Device rejected description.'],
  ])('turns an embedded RCI status into an error using %s', (_name, status, message) => {
    const api = createDeviceDescriptionApi(fakeRci(() => of({status: [{status: 'error', ...status}]})));

    const result = record(api.read());

    expect(result.values).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBeInstanceOf(DeviceRciStatusError);
    expect((result.errors[0] as Error).message).toBe(message);
    expect(result.completed).toBe(false);
  });

  it('uses the first error status and first available message field', () => {
    const api = createDeviceDescriptionApi(fakeRci(() =>
      of({status: [
        {status: 'ok'},
        {status: 'error', message: 'first', error: 'second'},
        {status: 'error', message: 'later'},
      ]})
    ));

    expect(record(api.read()).errors[0]).toMatchObject({message: 'first'});
  });

  it('writes the exact system.description query and emits void on success', () => {
    const queue = vi.fn(() => of({status: [{status: 'ok'}]}));
    const api = createDeviceDescriptionApi({queue} as unknown as RciManager);

    const result = record(api.write('Router name'));

    expect(queue).toHaveBeenCalledWith({path: 'system.description', data: 'Router name'});
    expect(result.values).toEqual([undefined]);
    expect(result.errors).toEqual([]);
    expect(result.completed).toBe(true);
  });

  it('rejects embedded status errors on write', () => {
    const api = createDeviceDescriptionApi(fakeRci(() => of({status: [{status: 'error', msg: 'Rejected'}]})));

    expect(record(api.write('Router name')).errors[0]).toMatchObject({
      name: 'DeviceRciStatusError',
      message: 'Rejected',
    });
  });

  it('passes transport errors through unchanged', () => {
    const error = new Error('offline');
    const api = createDeviceDescriptionApi(fakeRci(() => throwError(() => error)));

    expect(record(api.read()).errors).toEqual([error]);
  });
});

describe('validateDescription', () => {
  it('trims and accepts a non-empty value up to 64 characters', () => {
    expect(validateDescription('  Router name  ')).toEqual({kind: 'valid', value: 'Router name'});
    expect(validateDescription('x'.repeat(64))).toEqual({kind: 'valid', value: 'x'.repeat(64)});
  });

  it('rejects empty and whitespace-only values', () => {
    expect(validateDescription('')).toEqual({kind: 'invalid', message: 'validation.empty'});
    expect(validateDescription('  \n  ')).toEqual({kind: 'invalid', message: 'validation.empty'});
  });

  it('rejects a trimmed value longer than 64 characters', () => {
    expect(validateDescription(`${'x'.repeat(64)} `)).toEqual({kind: 'valid', value: 'x'.repeat(64)});
    expect(validateDescription('x'.repeat(65))).toEqual({kind: 'invalid', message: 'validation.too-long'});
  });
});
