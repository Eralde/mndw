import {expect, it} from 'vitest';
import type {Switchport} from '@mndw/sdk';
import {buildRows} from './rows.js';

function port(label: string, index: number): Switchport {
  return {
    id: `LAN${index + 1}`,
    label,
    index,
    type: 'ethernet',
    group: 'LAN',
    color: 'gray',
    interfaceId: `GigabitEthernet0/${index}`,
    isReversed: false,
  };
}

it('keeps the physical rows and their order', () => {
  const ports = [port('0', 0), port('1', 1), port('2', 2), port('3', 3)];

  expect(buildRows([['0'], ['1', '2', '3']], ports).map((row) => row.ports.map((item) => item.label))).toEqual([
    ['0'],
    ['1', '2', '3'],
  ]);
});

it('draws ports missing from the layout in one extra row by index', () => {
  const rows = buildRows([['0']], [port('3', 3), port('0', 0), port('2', 2)]);

  expect(rows.map((row) => row.ports.map((item) => item.label))).toEqual([['0'], ['2', '3']]);
});

it('does not repeat a port and skips unknown layout labels', () => {
  const rows = buildRows([['0', '0', '9']], [port('0', 0)]);

  expect(rows).toHaveLength(1);
  expect(rows[0].ports).toHaveLength(1);
});
