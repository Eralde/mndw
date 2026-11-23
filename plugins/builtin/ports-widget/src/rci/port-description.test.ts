import {expect, it, vi} from 'vitest';
import type {PluginRciManager} from '@mndw/sdk';
import {
  MAX_DESCRIPTION_LENGTH,
  readPortDescriptions,
  validatePortDescription,
  writePortDescription,
} from './port-description.js';

it('trims valid names and enforces the router description limit', () => {
  expect(validatePortDescription(' Office uplink ')).toEqual({kind: 'valid', value: 'Office uplink'});
  expect(validatePortDescription(' '.repeat(2))).toEqual({kind: 'invalid', reason: 'empty'});
  expect(validatePortDescription('x'.repeat(MAX_DESCRIPTION_LENGTH + 1))).toEqual({kind: 'invalid',
    reason: 'too-long'});
});

it('reads descriptions with the configuration query', async () => {
  const query = vi.fn().mockResolvedValue({GigabitEthernet0: {description: 'Printer'}});

  await expect(readPortDescriptions({query} as unknown as PluginRciManager)).resolves.toEqual({
    GigabitEthernet0: 'Printer',
  });
  expect(query).toHaveBeenCalledWith([{path: 'show.rc.interface'}]);
});

it('writes and saves a trimmed name', async () => {
  const query = vi.fn().mockResolvedValue([{}, {}]);

  await writePortDescription({query} as unknown as PluginRciManager, 'GigabitEthernet0', 'Office');

  expect(query).toHaveBeenCalledWith([
    {path: 'interface', data: {name: 'GigabitEthernet0', description: 'Office'}},
    {path: 'system.configuration.save'},
  ]);
});

it('clears a name with the no flag and reports router status errors', async () => {
  const query = vi.fn().mockResolvedValue([{status: [{status: 'error', message: 'Description is too long'}]}]);

  await expect(writePortDescription({query} as unknown as PluginRciManager, 'GigabitEthernet0', null))
    .rejects.toThrow('Description is too long');
  expect(query).toHaveBeenCalledWith([
    {path: 'interface', data: {name: 'GigabitEthernet0', description: {no: true}}},
    {path: 'system.configuration.save'},
  ]);
});
