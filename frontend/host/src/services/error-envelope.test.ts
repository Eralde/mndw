import {describe, expect, it} from 'vitest';
import {decodeErrorEnvelope, readErrorBody} from './error-envelope.js';

describe('decodeErrorEnvelope', () => {
  it('reads a well-formed envelope', () => {
    const fields = decodeErrorEnvelope({error: {code: 'NOT_APPROVED', message: 'no', detail: {id: 1}}}, 'Bad Request');

    expect(fields).toEqual({code: 'NOT_APPROVED', message: 'no', detail: {id: 1}});
  });

  it('degrades a present-but-empty error object to UNKNOWN and statusText', () => {
    const fields = decodeErrorEnvelope({error: {}}, 'Bad Request');

    expect(fields).toEqual({code: 'UNKNOWN', message: 'Bad Request', detail: undefined});
  });

  it.each([[null], [undefined], [[1, 2]], ['boom'], [42], [{error: 'boom'}], [{error: [1]}], [{error: null}]])(
    'degrades a non-envelope body %p to UNKNOWN and statusText',
    (body) => {
      expect(decodeErrorEnvelope(body, 'Bad Gateway')).toEqual({
        code: 'UNKNOWN',
        message: 'Bad Gateway',
        detail: undefined,
      });
    },
  );

  it('degrades non-string code and message instead of trusting JSON types', () => {
    const fields = decodeErrorEnvelope({error: {code: 42, message: {nested: true}, detail: 7}}, 'Bad Request');

    expect(fields).toEqual({code: 'UNKNOWN', message: 'Bad Request', detail: 7});
  });

  it('keeps detail as unknown rather than coercing it', () => {
    const fields = decodeErrorEnvelope({error: {code: 'X', message: 'y', detail: null}}, 'Bad Request');

    expect(fields.detail).toBeNull();
  });

  it('degrades empty-string code and message alongside non-strings', () => {
    const fields = decodeErrorEnvelope({error: {code: '', message: '', detail: 'x'}}, 'Bad Request');

    expect(fields).toEqual({code: 'UNKNOWN', message: 'Bad Request', detail: 'x'});
  });

  it('passes an empty statusText through unchanged (HTTP/2 sends none)', () => {
    expect(decodeErrorEnvelope(null, '')).toEqual({code: 'UNKNOWN', message: '', detail: undefined});
  });
});

describe('readErrorBody', () => {
  it('returns undefined for a body that is not JSON', async () => {
    const response = new Response('<html>', {status: 502, statusText: 'Bad Gateway'});

    expect(await readErrorBody(response)).toBeUndefined();
  });

  it('returns the parsed body for a JSON response', async () => {
    const response = new Response(JSON.stringify({error: {code: 'X'}}), {
      status: 400,
      statusText: 'Bad Request',
    });

    expect(await readErrorBody(response)).toEqual({error: {code: 'X'}});
  });
});
