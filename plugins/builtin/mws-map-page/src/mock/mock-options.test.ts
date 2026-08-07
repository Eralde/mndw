import {describe, expect, it} from 'vitest';
import {
  DEFAULT_MOCK_CLIENTS,
  DEFAULT_MOCK_EXTENDERS,
  MAX_MOCK_CLIENTS,
  MAX_MOCK_EXTENDERS,
  parseMockOptions,
} from './mock-options';

describe('parseMockOptions', () => {
  it('keeps live mode when mock query flag is absent', () => {
    expect(parseMockOptions('')).toEqual({mode: 'live', extenders: 0, clients: 0});
    expect(parseMockOptions('?mock=small')).toEqual({mode: 'live', extenders: 0, clients: 0});
  });

  it('uses large-mode defaults', () => {
    expect(parseMockOptions('?mock=large')).toEqual({
      mode: 'large',
      extenders: DEFAULT_MOCK_EXTENDERS,
      clients: DEFAULT_MOCK_CLIENTS,
    });
  });

  it('accepts valid extender and client counts', () => {
    expect(parseMockOptions('?mock=large&extenders=20&clients=100')).toEqual({
      mode: 'large',
      extenders: 20,
      clients: 100,
    });
  });

  it('falls back for invalid values and clamps oversized values', () => {
    expect(parseMockOptions('?mock=large&extenders=nope&clients=-2')).toEqual({
      mode: 'large',
      extenders: DEFAULT_MOCK_EXTENDERS,
      clients: 0,
    });
    expect(parseMockOptions('?mock=large&extenders=999&clients=9999')).toEqual({
      mode: 'large',
      extenders: MAX_MOCK_EXTENDERS,
      clients: MAX_MOCK_CLIENTS,
    });
  });
});
