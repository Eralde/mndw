import {describe, expect, it} from 'vitest';
import type {Sample} from '../model/api';
import {fnv1a64Hex, wakeConsentKey} from './wake-consent';

const sample = (model: string, serial: string): Sample => {
  return {
    schemaVersion: 1,
    deviceId: 'device-1',
    sampledAt: '2026-11-24T12:00:00Z',
    protocol: 'ata',
    identity: {reliable: true, model, serial, wwn: null, capacityBytes: null},
    temperatureC: null,
    powerOnHours: null,
    rotationRate: 5200,
    health: 'unknown',
    assessment: {level: 'unknown', reasons: [], rulesVersion: 1},
    counters: [],
    capabilities: {attributes: false, temperature: false, standbyOnlyValidated: false},
    attributes: [],
  };
};

describe('wake consent key', () => {
  it('derives a stable FNV-1a 64 key from the drive identity', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64Hex('foobar')).toBe('85944171f73967e8');
    expect(wakeConsentKey(sample('ACME HDD 2TB', 'SERIAL-0001'))).toBe('wake-consent:3ec2e54f7998cacb');
  });
});
