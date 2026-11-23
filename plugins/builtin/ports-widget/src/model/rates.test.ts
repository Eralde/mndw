import {expect, it} from 'vitest';
import type {Counters} from '../rci/parse-counters.js';
import {computeRates} from './rates.js';

function counters(timestamp: number, rx: number | null, tx: number | null): Counters {
  return {
    timestampSeconds: timestamp,
    rxBytes: rx,
    txBytes: tx,
    rxPackets: null,
    txPackets: null,
    rxErrors: null,
    txErrors: null,
    rxDropped: null,
    txDropped: null,
  };
}

it('turns the byte delta into bits per second over the router clock delta', () => {
  expect(computeRates(counters(10, 1000, 2000), counters(20, 4000, 3000))).toEqual({
    rxBitsPerSecond: 2400,
    txBitsPerSecond: 800,
  });
});

it('drops the rate for a direction whose counter went backwards', () => {
  expect(computeRates(counters(10, 4000, 2000), counters(20, 1000, 5000))).toEqual({
    rxBitsPerSecond: null,
    txBitsPerSecond: 2400,
  });
});

it('has no rate without two advancing snapshots', () => {
  expect(computeRates(null, counters(20, 1000, 1000))).toBeNull();
  expect(computeRates(counters(20, 1000, 1000), counters(20, 2000, 2000))).toBeNull();
  expect(computeRates(counters(20, 1000, 1000), counters(10, 2000, 2000))).toBeNull();
});
