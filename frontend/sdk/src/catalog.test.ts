import {describe, expect, it} from 'vitest';
import {flattenCatalog, parseCatalog} from './catalog.js';

describe('catalog parser', () => {
  it('flattens nested catalogs while preserving dotted and hyphenated key parts', () => {
    expect(parseCatalog({
      wifi: {
        encryption: {disabled: 'Unsecured'},
        band: {2: '2.4 GHz Wi-Fi', 5: '5 GHz Wi-Fi'},
      },
      error: {'integer-only': 'Only integer values are allowed'},
    }, 'test.json')).toEqual({
      'wifi.encryption.disabled': 'Unsecured',
      'wifi.band.2': '2.4 GHz Wi-Fi',
      'wifi.band.5': '5 GHz Wi-Fi',
      'error.integer-only': 'Only integer values are allowed',
    });
  });

  it('accepts flat dotted keys through the same parser', () => {
    expect(parseCatalog({'table.host': 'Host', 'table.last': 'Last'}, 'test.json')).toEqual({
      'table.host': 'Host',
      'table.last': 'Last',
    });
  });

  it('rejects duplicate flattened keys', () => {
    expect(() => parseCatalog({'wifi.band': 'flat', 'wifi': {band: 'nested'}}, 'test.json')).toThrow(
      'duplicate key "wifi.band"',
    );
  });

  it('rejects invalid roots and leaves', () => {
    expect(() => parseCatalog([], 'test.json')).toThrow('must be a JSON object');
    expect(() => parseCatalog({wifi: {band: 2}}, 'test.json')).toThrow('must be a string or object');
  });

  it('returns frozen output and supports the exported recursive helper', () => {
    const output: Record<string, string> = {};

    flattenCatalog({error: {'integer-only': 'Only integers'}}, 'test.json', '', output);

    expect(output).toEqual({'error.integer-only': 'Only integers'});
    expect(Object.isFrozen(parseCatalog({title: 'Title'}, 'test.json'))).toBe(true);
  });
});
