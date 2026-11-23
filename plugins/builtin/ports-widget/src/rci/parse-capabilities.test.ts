import {expect, it} from 'vitest';
import capabilitiesReply from '../fixtures/capabilities-xgigabit.json';
import {parseMaxSpeedMbps} from './parse-capabilities.js';

it('takes the largest advertised mdi speed', () => {
  expect(parseMaxSpeedMbps(capabilitiesReply)).toBe(10000);
});

it('reads numeric strings and skips unusable entries', () => {
  expect(parseMaxSpeedMbps({mdi: {phy: [{speed: '100'}, {speed: 2500}, {speed: 'nope'}, null]}})).toBe(2500);
});

it('returns null without an mdi phy table', () => {
  expect(parseMaxSpeedMbps({media: ['mdi']})).toBeNull();
  expect(parseMaxSpeedMbps(undefined)).toBeNull();
});
