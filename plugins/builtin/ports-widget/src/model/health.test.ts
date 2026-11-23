import {expect, it} from 'vitest';
import type {LinkInfo} from '../rci/parse-interface.js';
import {hasWarning, portWarning} from './health.js';

function link(overrides: Partial<LinkInfo> = {}): LinkInfo {
  return {
    status: 'up',
    speedMbps: 100,
    duplex: 'full',
    autoNegotiation: true,
    flowControl: true,
    eee: false,
    lastChangeSeconds: 1,
    hasSfp: false,
    ...overrides,
  };
}

it('flags a link-up port below its maximum speed', () => {
  const warning = portWarning(link(), 1000);

  expect(warning).toEqual({slowerThanMaximum: true, halfDuplex: false});
  expect(hasWarning(warning)).toBe(true);
});

it('flags half duplex even at the maximum speed', () => {
  expect(portWarning(link({duplex: 'half'}), 100)).toEqual({slowerThanMaximum: false, halfDuplex: true});
});

it('keeps a full-speed full-duplex link quiet', () => {
  expect(hasWarning(portWarning(link({speedMbps: 1000}), 1000))).toBe(false);
});

it('never flags a port without a link', () => {
  expect(hasWarning(portWarning(link({status: 'down'}), 1000))).toBe(false);
  expect(hasWarning(portWarning(null, 1000))).toBe(false);
});
