import {describe, expect, it} from 'vitest';
import {MAX_NODE_NAME, validateNodeName} from './node-name';

describe('validateNodeName', () => {
  it('trims surrounding whitespace and preserves internal whitespace', () => {
    expect(validateNodeName('  Mesh  Extender  ')).toEqual({value: 'Mesh  Extender', error: null, errorCode: null});
  });

  it('rejects empty and whitespace-only names', () => {
    expect(validateNodeName('')).toEqual({value: null, error: 'Name cannot be empty.', errorCode: 'empty'});
    expect(validateNodeName(' \t ')).toEqual({value: null, error: 'Name cannot be empty.', errorCode: 'empty'});
  });

  it('accepts exactly the maximum length', () => {
    expect(validateNodeName('a'.repeat(MAX_NODE_NAME))).toEqual({
      value: 'a'.repeat(MAX_NODE_NAME),
      error: null,
      errorCode: null,
    });
  });

  it('rejects names longer than the maximum', () => {
    expect(validateNodeName('a'.repeat(MAX_NODE_NAME + 1))).toEqual({
      value: null,
      error: 'Name must be 64 characters or fewer.',
      errorCode: 'too-long',
    });
  });
});
