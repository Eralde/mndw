import {describe, expect, it} from 'vitest';
import {type PageViewChoice, effectiveView} from './page-view';

describe('effectiveView', () => {
  it.each<[string, PageViewChoice, number, boolean, 'list' | 'details']>([
    ['opens the details of a single drive directly', null, 1, true, 'details'],
    ['starts at the list for several drives', null, 2, true, 'list'],
    ['returns to the list after back, even with a single drive', 'list', 1, true, 'list'],
    ['shows the details of a card that was opened', 'details', 3, true, 'details'],
    ['falls back to the list when the opened drive left the snapshot', 'details', 2, false, 'list'],
  ])('%s', (_name, choice, deviceCount, hasSelectedDevice, expected) => {
    expect(effectiveView({choice, deviceCount, hasSelectedDevice})).toBe(expected);
  });
});
