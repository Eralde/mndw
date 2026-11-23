import {expect, it} from 'vitest';
import countersReply from '../fixtures/counters.json';
import {parseCounters} from './parse-counters.js';

const expected = {
  timestampSeconds: 8387.675819,
  rxBytes: 1844674407,
  txBytes: 987654321,
  rxPackets: 1234567,
  txPackets: 765432,
  rxErrors: 0,
  txErrors: 3,
  rxDropped: 1,
  txDropped: 0,
};

it('parses the flat counter reply', () => {
  expect(parseCounters(countersReply)).toEqual(expected);
});

it('unwraps a reply keyed by interface id and a stat object', () => {
  const keyed = {'GigabitEthernet0/3': countersReply};
  const wrapped = {stat: countersReply};

  expect(parseCounters(keyed, 'GigabitEthernet0/3')).toEqual(expected);
  expect(parseCounters(wrapped)).toEqual(expected);
});

it('accepts numeric values in place of strings', () => {
  expect(parseCounters({timestamp: 10, rxbytes: 2048, txbytes: 1024})).toMatchObject({
    timestampSeconds: 10,
    rxBytes: 2048,
    txBytes: 1024,
  });
});

it('returns null when the reply carries no counters', () => {
  expect(parseCounters({})).toBeNull();
  expect(parseCounters('no')).toBeNull();
});
