import {describe, expect, it} from 'vitest';
import {decodeSessionList, decodeSessionPage, validateSessionId, validateSessionOptions} from './telemetry-sessions.js';

const validStorage = {
  mode: 'ready',
  issues: [],
  journalBytes: 1024,
  journalLimitBytes: 8388608,
  pendingSampleCount: 0,
  oldestPendingSession: null,
  deliveryError: null,
  coverage: [{series: 1, startMs: 1800000000000, endMs: 1800003600000, edgeComplete: true, complete: true,
    reasons: []}],
  droppedRecords: {},
};

const validSummary = {
  id: 's1-01020304050607080910111213141516',
  bootOrder: '42',
  elapsedStartMs: 0,
  elapsedEndMs: 180000,
  sampleCount: 10,
  conflictCount: 0,
  state: 'anchored',
  utcStartMs: 1800000000000,
  utcEndMs: 1800000180000,
};

const validSample = {
  sequence: '100',
  series: 1,
  elapsedMs: 180000,
  utcMs: 1800000180000,
  values: [20.5, null, 80.0],
  disposition: 'retained',
};

describe('validateSessionId', () => {
  it('accepts valid session id', () => {
    expect(() => validateSessionId('s1-01020304050607080910111213141516')).not.toThrow();
  });

  it('rejects invalid session ids', () => {
    expect(() => validateSessionId('')).toThrow();
    expect(() => validateSessionId('s1-')).toThrow();
    expect(() => validateSessionId('s1-0102030405060708091011121314151')).toThrow();
    expect(() => validateSessionId('s2-01020304050607080910111213141516')).toThrow();
    expect(() => validateSessionId('s1-0102030405060708091011121314151G')).toThrow();
    expect(() => validateSessionId('../etc/passwd')).toThrow();
  });
});

describe('validateSessionOptions', () => {
  it('accepts valid options', () => {
    expect(() => validateSessionOptions({})).not.toThrow();
    expect(() => validateSessionOptions({limit: 1})).not.toThrow();
    expect(() => validateSessionOptions({limit: 1000})).not.toThrow();
    expect(() => validateSessionOptions({after: 'cursor'})).not.toThrow();
    expect(() => validateSessionOptions({after: 'cursor', limit: 200})).not.toThrow();
  });

  it('rejects invalid limits', () => {
    expect(() => validateSessionOptions({limit: 0})).toThrow();
    expect(() => validateSessionOptions({limit: 1001})).toThrow();
    expect(() => validateSessionOptions({limit: -1})).toThrow();
    expect(() => validateSessionOptions({limit: 1.5})).toThrow();
  });
});

describe('decodeSessionList', () => {
  it('decodes a valid list with sessions', () => {
    const result = decodeSessionList({sessions: [validSummary], storage: validStorage});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.id).toBe('s1-01020304050607080910111213141516');
    expect(result.sessions[0]?.bootOrder).toBe('42');
    expect(result.sessions[0]?.state).toBe('anchored');
    expect(result.storage.mode).toBe('ready');
  });

  it('decodes null UTC in summary', () => {
    const noUtc = {...validSummary, utcStartMs: null, utcEndMs: null, state: 'unanchored'};
    const result = decodeSessionList({sessions: [noUtc], storage: validStorage});

    expect(result.sessions[0]?.utcStartMs).toBeNull();
    expect(result.sessions[0]?.utcEndMs).toBeNull();
  });

  it('decodes empty session list with unavailable storage', () => {
    const unavailable = {
      ...validStorage,
      mode: 'unavailable',
      journalBytes: null,
      pendingSampleCount: null,
      issues: [{code: 'lock-busy', firstSequence: null, lastSequence: null}],
    };
    const result = decodeSessionList({sessions: [], storage: unavailable});

    expect(result.sessions).toHaveLength(0);
    expect(result.storage.mode).toBe('unavailable');
    expect(result.storage.issues[0]?.code).toBe('lock-busy');
  });

  it('rejects malformed list', () => {
    expect(() => decodeSessionList(null)).toThrow();
    expect(() => decodeSessionList({sessions: 'invalid', storage: validStorage})).toThrow();
    expect(() => decodeSessionList({sessions: [{}], storage: validStorage})).toThrow();
  });

  it('rejects excessive session count', () => {
    const sessions = Array.from({length: 65}, () => validSummary);

    expect(() => decodeSessionList({sessions, storage: validStorage})).toThrow();
  });

  it('rejects invalid session state', () => {
    expect(() =>
      decodeSessionList({
        sessions: [{...validSummary, state: 'invalid'}],
        storage: validStorage,
      })
    ).toThrow();
  });

  it('rejects invalid bootOrder format', () => {
    expect(() =>
      decodeSessionList({
        sessions: [{...validSummary, bootOrder: 'abc'}],
        storage: validStorage,
      })
    ).toThrow();
  });
});

describe('decodeSessionPage', () => {
  const validPage = {
    samples: [validSample],
    nextCursor: null,
    truncated: false,
    truncationReasons: [],
    storage: validStorage,
  };

  it('decodes a valid page with samples', () => {
    const result = decodeSessionPage(validPage);

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.sequence).toBe('100');
    expect(result.samples[0]?.values).toEqual([20.5, null, 80.0]);
    expect(result.samples[0]?.disposition).toBe('retained');
    expect(result.nextCursor).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('decodes null UTC in sample', () => {
    const page = {...validPage, samples: [{...validSample, utcMs: null}]};
    const result = decodeSessionPage(page);

    expect(result.samples[0]?.utcMs).toBeNull();
  });

  it('decodes a page with cursor and truncation', () => {
    const page = {
      ...validPage,
      nextCursor: 'AQECAwQFBgcICRAREhMUFRYAAAAAA',
      truncated: true,
      truncationReasons: ['budget'],
    };
    const result = decodeSessionPage(page);

    expect(result.nextCursor).toBe('AQECAwQFBgcICRAREhMUFRYAAAAAA');
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(['budget']);
  });

  it('accepts all valid dispositions', () => {
    for (const disposition of ['retained', 'pending', 'conflict', 'unproven']) {
      const page = {...validPage, samples: [{...validSample, disposition}]};

      expect(() => decodeSessionPage(page)).not.toThrow();
    }
  });

  it('rejects invalid disposition', () => {
    const page = {...validPage, samples: [{...validSample, disposition: 'delivered'}]};

    expect(() => decodeSessionPage(page)).toThrow();
  });

  it('rejects malformed page', () => {
    expect(() => decodeSessionPage(null)).toThrow();
    expect(() => decodeSessionPage({...validPage, samples: 'invalid'})).toThrow();
    expect(() => decodeSessionPage({...validPage, truncated: 'yes'})).toThrow();
  });

  it('rejects non-finite sample values', () => {
    const page = {...validPage, samples: [{...validSample, values: [Infinity]}]};

    expect(() => decodeSessionPage(page)).toThrow();
  });

  it('rejects excessive value count', () => {
    const page = {...validPage, samples: [{...validSample, values: Array.from({length: 65}, () => 1)}]};

    expect(() => decodeSessionPage(page)).toThrow();
  });

  it('rejects non-decimal sequence', () => {
    const page = {...validPage, samples: [{...validSample, sequence: '0xff'}]};

    expect(() => decodeSessionPage(page)).toThrow();
  });

  it('decodes storage with read-only salvage', () => {
    const readOnly = {
      ...validStorage,
      mode: 'read-only',
      issues: [{code: 'corrupt-tail', firstSequence: '42', lastSequence: '50'}],
    };
    const page = {...validPage, storage: readOnly};
    const result = decodeSessionPage(page);

    expect(result.storage.mode).toBe('read-only');
    expect(result.storage.issues[0]?.firstSequence).toBe('42');
  });

  it('decodes storage with dropped records', () => {
    const withDropped = {...validStorage, droppedRecords: {age: '12', budget: '3'}};
    const page = {...validPage, storage: withDropped};
    const result = decodeSessionPage(page);

    expect(result.storage.droppedRecords).toEqual({age: '12', budget: '3'});
  });
});
