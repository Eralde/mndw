import {expect, it} from 'vitest';
import {DEFAULT_SETTINGS, MAX_ROWS, ROW_KINDS, parseSettings} from './settings.js';

it('defaults to description, speed, and duplex rows', () => {
  expect(DEFAULT_SETTINGS).toEqual({rows: ['description', 'speed', 'duplex']});
});

it('accepts each supported row once and allows repeated separators up to eight rows', () => {
  const rows = [
    'description',
    'speed',
    'duplex',
    'rx-total',
    'tx-total',
    'rx-rate',
    'tx-rate',
    'separator',
  ];

  expect(parseSettings({rows})).toEqual({rows});
  expect(parseSettings({rows: ['separator', 'separator']})).toEqual({rows: ['separator', 'separator']});
  expect(ROW_KINDS).toContain('rx-dropped');
  expect(MAX_ROWS).toBe(8);
});

it.each([
  null,
  'bad data',
  {name: true, duplex: true, speed: true, traffic: 'rate', errors: false},
  {},
  {rows: 'speed'},
  {rows: ['speed', 'speed']},
  {rows: ['separator', 'description', 'description']},
  {rows: ['unknown']},
  {rows: ['description', 'speed', 'duplex', 'rx-total', 'tx-total', 'rx-rate', 'tx-rate', 'rx-errors', 'tx-errors']},
])('falls back to defaults for invalid stored rows: %j', (value) => {
  expect(parseSettings(value)).toEqual(DEFAULT_SETTINGS);
});
