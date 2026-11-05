import type {PluginRciManager} from '@mndw/sdk';
import {of} from 'rxjs';
import {expect, it, vi} from 'vitest';
import {createDeviceDescriptionApi} from './device-description.js';

it('reads the description and sends a write query', () => {
  const queue = vi.fn()
    .mockReturnValueOnce(of({description: ' Router '}))
    .mockReturnValueOnce(of({status: [{status: 'ok'}]}));
  const api = createDeviceDescriptionApi({queue} as unknown as PluginRciManager);
  const values: Array<string | void> = [];

  api.read().subscribe((value) => {
    values.push(value);
  });
  api.write('New').subscribe((value) => {
    values.push(value);
  });

  expect(queue.mock.calls).toEqual([
    [{path: 'show.version'}],
    [{path: 'system.description', data: 'New'}],
  ]);
  expect(values).toEqual(['Router', undefined]);
});
