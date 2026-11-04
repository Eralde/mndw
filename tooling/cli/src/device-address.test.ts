import {describe, expect, it} from 'vitest';

import {CliError} from './errors.js';
import {normalizeDeviceAddress} from './device-address.js';

describe('normalizeDeviceAddress', () => {
  it.each([
    ['192.168.1.1', 'http://192.168.1.1'],
    ['router.local:8080', 'http://router.local:8080'],
    ['https://x/', 'https://x'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeDeviceAddress(input)).toBe(expected);
  });

  it.each(['', '   ', 'http://router.local/path', 'https://x/path'])('rejects %j', (input) => {
    expect(() => normalizeDeviceAddress(input)).toThrow(
      new CliError(`Invalid --addr "${input}": expected an IP, host[:port] or http(s) URL`),
    );
  });
});
