import {isNonEmptyString, isRecord} from './json.js';

// Fields of the daemon's structured error envelope after narrowing. `detail` is
// code-specific and stays unknown: each client projects it with its own decoder
// (see dependencyConflictDetail in opkg-client.ts).
export interface ErrorEnvelopeFields {
  code: string;
  message: string;
  detail: unknown;
}

// Reads a non-2xx response body. `undefined` means the body was not parseable
// JSON; callers pass it straight to decodeErrorEnvelope and get the statusText
// fallback for free.
export const readErrorBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

// Decodes {"error":{"code","message","detail"}}. A field counts as present only
// when it is a non-empty string: empty strings degrade to UNKNOWN / statusText
// the same way non-strings do, because "" is useless to callers (MESSAGE_KEYS['']
// misses and an empty message renders as an empty toast).
export function decodeErrorEnvelope(body: unknown, statusText: string): ErrorEnvelopeFields {
  const envelope = isRecord(body) ? body : undefined;
  const errorValue = envelope?.error;
  const error = isRecord(errorValue) ? errorValue : undefined;
  const code = error?.code;
  const message = error?.message;

  return {
    code: isNonEmptyString(code) ? code : 'UNKNOWN',
    // statusText is passed through verbatim, including '' — HTTP/2 responses have
    // no reason phrase, and inventing one here is a UI-text decision, not a decode one.
    message: isNonEmptyString(message) ? message : statusText,
    detail: error?.detail,
  };
}
