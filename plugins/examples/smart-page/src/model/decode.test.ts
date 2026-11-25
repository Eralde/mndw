// @vitest-environment node

import {readFileSync, readdirSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {SettingsRequest} from './api';
import {
  decodeAcceptedOperation,
  decodeApiError,
  decodeConfig,
  decodeDeviceTypeResponse,
  decodeHistory,
  decodeOperation,
  decodeSnapshot,
  encodeSettingsRequest,
} from './decode';

const fixtureDirectory = new URL('../../backend/testdata/wire/', import.meta.url);

interface InvalidHistoryCase {
  name: string;
  mutate: (history: Record<string, unknown>) => void;
}

function readFixture(filename: string): unknown {
  return JSON.parse(readFileSync(new URL(filename, fixtureDirectory), 'utf8')) as unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected fixture object');
  }

  return value as Record<string, unknown>;
}

function firstHistoryBucket(history: Record<string, unknown>): Record<string, unknown> {
  const buckets = history.buckets as unknown[];
  const bucket = buckets[0];

  return objectValue(bucket);
}

const invalidHistoryCases: InvalidHistoryCase[] = [
  {
    name: 'invalid clock status requires clock-invalid reason',
    mutate: (history) => {
      history.clockStatus = 'invalid';
    },
  },
  {
    name: 'rollback history cannot retain buckets',
    mutate: (history) => {
      history.clockStatus = 'rollback';
      history.reason = 'clock-invalid';
    },
  },
  {
    name: 'invalid clock requires zero sample count',
    mutate: (history) => {
      history.clockStatus = 'invalid';
      history.reason = 'clock-invalid';
      history.buckets = [];
      objectValue(history.coverage).sampleCount = 1;
    },
  },
  {
    name: 'invalid clock requires zero covered seconds',
    mutate: (history) => {
      history.clockStatus = 'invalid';
      history.reason = 'clock-invalid';
      history.buckets = [];
      objectValue(history.coverage).sampleCount = 0;
      objectValue(history.coverage).coveredSeconds = 1;
    },
  },
  {
    name: 'identity-unreliable history cannot retain buckets',
    mutate: (history) => {
      history.reason = 'identity-unreliable';
    },
  },
  {
    name: 'valid clock cannot use clock-invalid reason',
    mutate: (history) => {
      history.reason = 'clock-invalid';
    },
  },
  {
    name: 'temperature below physical minimum is rejected',
    mutate: (history) => {
      objectValue(firstHistoryBucket(history).temperatureC).min = -273.16;
    },
  },
  {
    name: 'temperature above contract maximum is rejected',
    mutate: (history) => {
      objectValue(firstHistoryBucket(history).temperatureC).max = 10000.1;
    },
  },
  {
    name: 'temperature precision beyond three decimals is rejected',
    mutate: (history) => {
      objectValue(firstHistoryBucket(history).temperatureC).last = 41.0001;
    },
  },
  {
    name: 'non-finite temperature is rejected',
    mutate: (history) => {
      objectValue(firstHistoryBucket(history).temperatureC).max = Number.POSITIVE_INFINITY;
    },
  },
  {
    name: 'duplicate counter names in a bucket are rejected',
    mutate: (history) => {
      const counters = firstHistoryBucket(history).counters as unknown[];

      counters.push(structuredClone(counters[0]));
    },
  },
  {
    name: 'hourStart with nonzero minutes is rejected',
    mutate: (history) => {
      firstHistoryBucket(history).hourStart = '2026-11-24T08:01:00Z';
    },
  },
  {
    name: 'hourStart with nonzero seconds is rejected',
    mutate: (history) => {
      firstHistoryBucket(history).hourStart = '2026-11-24T08:00:01Z';
    },
  },
];

const snapshotFixtures = readdirSync(fixtureDirectory)
  .filter((filename) => /^snapshot.*\.golden\.json$/.test(filename))
  .sort();

describe.each(snapshotFixtures)('snapshot fixture %s', (filename) => {
  it('decodes shared snapshot wire data', () => {
    const snapshot = decodeSnapshot(readFixture(filename));

    expect(snapshot.schemaVersion).toBe(1);
    expect(Array.isArray(snapshot.devices)).toBe(true);
  });
});

describe('wire decoders', () => {
  it('decodes device type response fixture and rejects invalid device metadata', () => {
    const response = decodeDeviceTypeResponse(readFixture('device-type.golden.json'));

    expect(response).toEqual({schemaVersion: 1, deviceId: 'dev-a', deviceType: 'sntasmedia', deviceTypeSource: 'user'});

    const snapshot = objectValue(structuredClone(readFixture('snapshot.golden.json')));
    const device = objectValue((snapshot.devices as unknown[])[0]);

    device.deviceTypeSource = 'future';

    expect(() => decodeSnapshot(snapshot)).toThrow();
    device.deviceTypeSource = 'scan';
    device.usbBridge = null;

    expect(() => decodeSnapshot(snapshot)).not.toThrow();
    device.usbBridge = 1058;

    expect(() => decodeSnapshot(snapshot)).toThrow();
  });

  it('decodes nullable fields and large decimal counters without numeric conversion', () => {
    const snapshot = decodeSnapshot(readFixture('snapshot.golden.json'));
    const device = snapshot.devices[0];
    const sample = device?.sample;

    expect(device?.polling).toBeNull();
    expect(sample?.identity.serial).toBeNull();
    expect(sample?.temperatureC).toBeNull();
    expect(sample?.powerOnHours).toBe('18446744073709551615');
    expect(sample?.counters[0]?.value).toBe('18446744073709551615');
    expect(snapshot.config).toBeNull();
    expect(snapshot.persistence).toBeNull();
  });

  it('accepts nullable sample rotation rates and rejects invalid or missing values', () => {
    for (const rotationRate of [null, 0, 5200]) {
      const snapshot = objectValue(structuredClone(readFixture('snapshot.golden.json')));
      const device = objectValue((snapshot.devices as unknown[])[0]);
      const sample = objectValue(device.sample);

      sample.rotationRate = rotationRate;

      const decoded = decodeSnapshot(snapshot).devices[0]?.sample;

      expect(decoded === null ? null : (decoded as unknown as Record<string, unknown>).rotationRate).toBe(rotationRate);
    }

    for (const rotationRate of [-1, 1.5, '7200']) {
      const snapshot = objectValue(structuredClone(readFixture('snapshot.golden.json')));
      const device = objectValue((snapshot.devices as unknown[])[0]);
      const sample = objectValue(device.sample);

      sample.rotationRate = rotationRate;

      expect(() => decodeSnapshot(snapshot)).toThrow();
    }

    const snapshot = objectValue(structuredClone(readFixture('snapshot.golden.json')));
    const device = objectValue((snapshot.devices as unknown[])[0]);
    const sample = objectValue(device.sample);

    delete sample.rotationRate;

    expect(() => decodeSnapshot(snapshot)).toThrow();
  });

  it('decodes every operation fixture as its own tagged result', () => {
    const values = readFixture('operation.golden.json');

    expect(Array.isArray(values)).toBe(true);

    const operations = (values as unknown[]).map((value) => decodeOperation(value));

    expect(operations.map((operation) => operation.status)).toEqual([
      'queued',
      'running',
      'succeeded',
      'succeeded',
      'failed',
      'cancelled',
    ]);
    expect(operations[2]?.result?.kind).toBe('discover');
    expect(operations[3]?.result?.kind).toBe('refresh');
    expect(decodeAcceptedOperation({schemaVersion: 1, operationId: 'op-a'}).operationId).toBe('op-a');
  });

  it('decodes history and config golden fixtures', () => {
    const history = decodeHistory(readFixture('history.golden.json'));
    const config = decodeConfig(readFixture('config.golden.json'));
    const boundaryHistory = objectValue(structuredClone(readFixture('history.golden.json')));
    const boundaryTemperature = objectValue(firstHistoryBucket(boundaryHistory).temperatureC);

    boundaryTemperature.min = -273.15;
    boundaryTemperature.max = 10000;
    boundaryTemperature.last = 41.001;

    expect(history.buckets).toHaveLength(2);
    expect(history.gaps).toHaveLength(3);
    expect(history.buckets[1]?.temperatureC).toBeNull();
    expect(config.revision).toBe('1');
    expect(config.devices.map((device) => device.mode)).toEqual(['off', 'allow-wake']);
    expect(() => decodeHistory(boundaryHistory)).not.toThrow();
  });

  it.each(invalidHistoryCases)('rejects invalid history contract: $name', ({mutate}) => {
    const history = objectValue(structuredClone(readFixture('history.golden.json')));

    mutate(history);

    expect(() => decodeHistory(history)).toThrow();
  });

  it('encodes the settings request in the shared golden shape', () => {
    const settings: SettingsRequest = {
      expectedRevision: '0',
      persistentHistory: true,
      devices: [
        {deviceId: 'dev-a', mode: 'off'},
        {deviceId: 'dev-b', mode: 'allow-wake', acknowledgeWake: true},
      ],
    };

    expect(JSON.parse(encodeSettingsRequest(settings)) as unknown).toEqual(readFixture('settings.golden.json'));
  });

  it('decodes API errors and accepts unknown response fields', () => {
    expect(decodeApiError(readFixture('error.golden.json')).error.code).toBe('revision-conflict');

    const snapshot = readFixture('snapshot.golden.json') as Record<string, unknown>;

    expect(() => decodeSnapshot({...snapshot, futureField: {any: 'value'}})).not.toThrow();
  });

  it('rejects unknown schema versions, enums, and missing required nullable fields', () => {
    const snapshot = readFixture('snapshot.golden.json') as Record<string, unknown>;

    expect(() => decodeSnapshot({...snapshot, schemaVersion: 2})).toThrow();
    expect(() => decodeSnapshot({...snapshot, clockStatus: 'future-clock-state'})).toThrow();
    expect(() => decodeSnapshot({...snapshot, serverNow: '2026-02-31T12:00:00Z'})).toThrow();
    expect(() => decodeSnapshot({...snapshot, devices: null})).toThrow();

    const missingNullable = structuredClone(snapshot);
    const missingDevice = (missingNullable.devices as Record<string, unknown>[])[0];
    const missingSample = missingDevice?.sample as Record<string, unknown>;
    const missingIdentity = missingSample.identity as Record<string, unknown>;

    delete missingIdentity.serial;

    expect(() => decodeSnapshot(missingNullable)).toThrow();

    const operations = readFixture('operation.golden.json') as Record<string, unknown>[];
    const succeeded = operations[2];
    const queued = operations[0];

    expect(() => decodeOperation({...succeeded, status: 'future-status'})).toThrow();
    expect(() => decodeOperation({...queued, result: {kind: 'discover', deviceIds: [], truncated: false, exitCode: 0}}))
      .toThrow();
  });
});
