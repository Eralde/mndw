import {expect, it} from 'vitest';
import {compareVersions} from './compare-versions.js';

const lt = (a: string, b: string): void => {
  expect(Math.sign(compareVersions(a, b))).toBe(-1);
};

it('orders opkg-style versions per the pinned rule', () => {
  lt('1.9', '1.10');
  lt('1.2.3', '1.2.3-1');
  lt('1.2.3-1', '1.2.3-2');
  lt('1.2.3', '1.2.3+deb');
  lt('1.2.9-5', '1.2.10-1');
  expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
});
