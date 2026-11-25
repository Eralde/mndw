import type {
  AcceptedOperation,
  ApiError,
  Config,
  DeviceTypeResponse,
  HistoryResponse,
  Operation,
  OperationKind,
  OperationStatus,
  SettingsRequest,
  Snapshot,
} from './api';

type RecordValue = Record<string, unknown>;
type Validator = (value: unknown, path: string) => void;

const healthValues = ['passed', 'failed', 'unknown'] as const;
const levelValues = ['critical', 'warning', 'normal', 'unknown'] as const;
const reasonValues = [
  'smart-health-failed',
  'ata-current-threshold-failure',
  'nvme-critical-warning',
  'nvme-spare-below-threshold',
  'nvme-percentage-used',
  'ata-pending-sectors',
  'ata-uncorrectable-sectors',
  'no-health-data',
  'no-applicable-warning',
] as const;
const collectionValues = [
  'ok',
  'sleeping',
  'unsupported',
  'permission-denied',
  'timeout',
  'invalid-output',
  'command-failed',
  'disconnected',
  'never-read',
] as const;
const modeValues = ['off', 'allow-wake', 'standby-only'] as const;
const pollingValues = ['active', 'needs-validation', 'suspended'] as const;
const operationStatusValues = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
const operationKindValues = ['discover', 'refresh'] as const;
const smartdValues = ['detected', 'not-detected', 'unknown'] as const;
const clockValues = ['valid', 'invalid', 'rollback'] as const;
const persistenceValues = ['enabled', 'disabled', 'degraded'] as const;
const protocolValues = ['ata', 'nvme', 'scsi', 'unknown'] as const;
const bindingValues = ['provisional', 'validated', 'disconnected'] as const;
const deviceTypeSourceValues = ['scan', 'user'] as const;
const historyReasonValues = ['identity-unreliable', 'clock-invalid'] as const;

const historyCounterUnits: Record<string, readonly string[]> = {
  power_on_hours: ['hours'],
  reallocated_sector_count: ['sectors'],
  current_pending_sector_count: ['sectors'],
  offline_uncorrectable_sector_count: ['sectors'],
  udma_crc_error_count: ['errors'],
  data_units_read: ['data-units'],
  data_units_written: ['data-units'],
  media_errors: ['errors'],
  unsafe_shutdowns: ['events'],
  critical_warning: ['bitmask'],
  available_spare: ['percent'],
  percentage_used: ['percent'],
};

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`);
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'expected object');
  }

  return value as RecordValue;
}

function required(value: RecordValue, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return fail(`${path}.${key}`, 'required field is missing');
  }

  return value[key];
}

function checkField(value: RecordValue, key: string, path: string, validator: Validator): unknown {
  const fieldValue = required(value, key, path);

  validator(fieldValue, `${path}.${key}`);

  return fieldValue;
}

function checkObject(value: unknown, path: string, validator: (object: RecordValue, path: string) => void): void {
  validator(record(value, path), path);
}

function checkString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') {
    fail(path, 'expected string');
  }
}

function checkText(value: unknown, path: string): void {
  checkString(value, path);

  if (new TextEncoder().encode(value).byteLength > 256) {
    fail(path, 'text exceeds 256 UTF-8 bytes');
  }
}

function checkUSBBridge(value: unknown, path: string): void {
  checkText(value, path);

  if (!/^[0-9a-f]{4}:[0-9a-f]{4}$/.test(value as string)) {
    fail(path, 'expected lowercase USB vendor:product ID');
  }
}

function checkId(value: unknown, path: string): void {
  checkString(value, path);

  if (value.length > 128) {
    fail(path, 'id must be at most 128 ASCII bytes');
  }

  for (const character of value) {
    if (character.charCodeAt(0) > 0x7f) {
      fail(path, 'id must be at most 128 ASCII bytes');
    }
  }
}

function checkDecimal(value: unknown, path: string, maxDigits?: number): void {
  checkString(value, path);

  const expression = maxDigits === undefined ? /^(0|[1-9][0-9]*)$/ : new RegExp(`^(0|[1-9][0-9]{0,${maxDigits - 1}})$`);

  if (!expression.test(value)) {
    fail(path, 'expected an unsigned decimal string without leading zeroes');
  }
}

function checkDateTime(value: unknown, path: string): void {
  checkString(value, path);

  if (
    !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    fail(path, 'expected UTC RFC3339 timestamp ending in Z');
  }

  const normalizedDate = new Date(value).toISOString();

  if (normalizedDate.slice(0, 10) !== value.slice(0, 10)) {
    fail(path, 'expected valid calendar date');
  }
}

function checkHourStart(value: unknown, path: string): void {
  checkDateTime(value, path);

  if (typeof value === 'string' && !/T\d{2}:00:00Z$/.test(value)) {
    fail(path, 'hourStart must be on a UTC hour boundary');
  }
}

function checkNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'expected finite number');
  }
}

function checkInteger(
  value: unknown,
  path: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): void {
  checkNumber(value, path);

  if (!Number.isInteger(value) || value < min || value > max) {
    fail(path, 'expected integer in range');
  }
}

function checkBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') {
    fail(path, 'expected boolean');
  }
}

function checkEnum(value: unknown, values: readonly string[], path: string): void {
  if (typeof value !== 'string' || !values.includes(value)) {
    fail(path, `unknown enum value ${String(value)}`);
  }
}

function checkNullable(value: unknown, path: string, validator: Validator): void {
  if (value !== null) {
    validator(value, path);
  }
}

function checkArray(value: unknown, path: string, validator: Validator, maxLength: number): void {
  if (!Array.isArray(value)) {
    fail(path, 'expected array');
  }

  if (value.length > maxLength) {
    fail(path, `array exceeds ${maxLength} items`);
  }

  value.forEach((item: unknown, index: number) => {
    validator(item, `${path}[${index}]`);
  });
}

function checkSchema(object: RecordValue, path: string): void {
  const version = checkField(object, 'schemaVersion', path, checkInteger);

  if (version !== 1) {
    fail(`${path}.schemaVersion`, `unsupported schema version ${String(version)}`);
  }
}

function checkAssessment(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'level', objectPath, (fieldValue, fieldPath) => checkEnum(fieldValue, levelValues, fieldPath));

    const reasons = checkField(
      object,
      'reasons',
      objectPath,
      (fieldValue, fieldPath) =>
        checkArray(fieldValue, fieldPath, (item, itemPath) => checkEnum(item, reasonValues, itemPath), 9),
    ) as unknown[];

    if (new Set(reasons).size !== reasons.length) {
      fail(`${objectPath}.reasons`, 'reason values must be unique');
    }

    const rulesVersion = checkField(object, 'rulesVersion', objectPath, checkInteger);

    if (rulesVersion !== 1) {
      fail(`${objectPath}.rulesVersion`, 'unsupported rules version');
    }
  });
}

function checkIdentity(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'reliable', objectPath, checkBoolean);
    checkField(object, 'model', objectPath, (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkText));
    checkField(
      object,
      'serial',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkText),
    );
    checkField(object, 'wwn', objectPath, (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkText));
    checkField(
      object,
      'capacityBytes',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkDecimal),
    );
  });
}

function checkCounter(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'name', objectPath, checkText);
    checkField(object, 'value', objectPath, checkDecimal);
    checkField(object, 'unit', objectPath, checkText);
  });
}

function checkHistoryCounter(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    const name = checkField(object, 'name', objectPath, checkText);
    const unit = checkField(object, 'unit', objectPath, checkText);

    checkField(object, 'value', objectPath, (fieldValue, fieldPath) => checkDecimal(fieldValue, fieldPath, 39));

    if (typeof name === 'string' && typeof unit === 'string' && !historyCounterUnits[name]?.includes(unit)) {
      fail(`${objectPath}.unit`, `unsupported history counter ${name}/${unit}`);
    }
  });
}

function checkHistoryCounters(value: unknown, path: string): void {
  checkArray(value, path, checkHistoryCounter, 8);

  const names = (value as unknown[]).map((counter, index) => record(counter, `${path}[${index}]`).name);

  if (new Set(names).size !== names.length) {
    fail(path, 'counter names must be unique within a bucket');
  }
}

function checkAttribute(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(
      object,
      'id',
      objectPath,
      (fieldValue, fieldPath) =>
        checkNullable(fieldValue, fieldPath, (numberValue, numberPath) => checkInteger(numberValue, numberPath, 0)),
    );
    checkField(object, 'name', objectPath, checkText);
    checkField(object, 'raw', objectPath, (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkText));
    checkField(
      object,
      'normalized',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkNumber),
    );
    checkField(
      object,
      'threshold',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkNumber),
    );
  });
}

function checkSample(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkSchema(object, objectPath);
    checkField(object, 'deviceId', objectPath, checkId);
    checkField(object, 'sampledAt', objectPath, checkDateTime);
    checkField(
      object,
      'protocol',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, protocolValues, fieldPath),
    );
    checkField(object, 'identity', objectPath, checkIdentity);
    checkField(
      object,
      'temperatureC',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkNumber),
    );
    checkField(
      object,
      'powerOnHours',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkDecimal),
    );
    checkField(
      object,
      'rotationRate',
      objectPath,
      (fieldValue, fieldPath) =>
        checkNullable(
          fieldValue,
          fieldPath,
          (rotationValue, rotationPath) => checkInteger(rotationValue, rotationPath, 0, 100000),
        ),
    );
    checkField(object, 'health', objectPath, (fieldValue, fieldPath) => checkEnum(fieldValue, healthValues, fieldPath));
    checkField(object, 'assessment', objectPath, checkAssessment);
    checkField(
      object,
      'counters',
      objectPath,
      (fieldValue, fieldPath) => checkArray(fieldValue, fieldPath, checkCounter, 32),
    );
    checkObject(
      required(object, 'capabilities', objectPath),
      `${objectPath}.capabilities`,
      (capabilities, capabilitiesPath) => {
        checkField(capabilities, 'attributes', capabilitiesPath, checkBoolean);
        checkField(capabilities, 'temperature', capabilitiesPath, checkBoolean);
        checkField(capabilities, 'standbyOnlyValidated', capabilitiesPath, checkBoolean);
      },
    );
    checkField(
      object,
      'attributes',
      objectPath,
      (fieldValue, fieldPath) => checkArray(fieldValue, fieldPath, checkAttribute, 256),
    );
  });
}

function checkPolling(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'mode', objectPath, (fieldValue, fieldPath) => checkEnum(fieldValue, modeValues, fieldPath));
    checkField(
      object,
      'status',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, pollingValues, fieldPath),
    );
    checkField(
      object,
      'nextDue',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkDateTime),
    );
  });
}

function checkDevice(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'deviceId', objectPath, checkId);
    checkField(object, 'path', objectPath, checkText);
    checkField(object, 'deviceType', objectPath, checkText);
    checkField(
      object,
      'deviceTypeSource',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, deviceTypeSourceValues, fieldPath),
    );
    checkField(
      object,
      'usbBridge',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkUSBBridge),
    );
    checkField(
      object,
      'binding',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, bindingValues, fieldPath),
    );
    checkField(
      object,
      'sample',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkSample),
    );
    checkObject(
      required(object, 'collection', objectPath),
      `${objectPath}.collection`,
      (collection, collectionPath) => {
        checkField(
          collection,
          'status',
          collectionPath,
          (fieldValue, fieldPath) => checkEnum(fieldValue, collectionValues, fieldPath),
        );
        checkField(
          collection,
          'exitCode',
          collectionPath,
          (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkInteger),
        );
      },
    );
    checkObject(required(object, 'freshness', objectPath), `${objectPath}.freshness`, (freshness, freshnessPath) => {
      checkField(
        freshness,
        'lastAttemptAt',
        freshnessPath,
        (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkDateTime),
      );
      checkField(
        freshness,
        'lastSuccessAt',
        freshnessPath,
        (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkDateTime),
      );
      checkField(freshness, 'stale', freshnessPath, checkBoolean);
    });
    checkField(
      object,
      'polling',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkPolling),
    );
    checkField(object, 'truncated', objectPath, checkBoolean);
  });
}

function checkDeviceTypeResponse(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkSchema(object, objectPath);
    checkField(object, 'deviceId', objectPath, checkId);
    checkField(object, 'deviceType', objectPath, checkText);
    checkField(
      object,
      'deviceTypeSource',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, deviceTypeSourceValues, fieldPath),
    );
  });
}

function checkDiagnostics(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'checkedAt', objectPath, checkDateTime);
    checkField(
      object,
      'euid',
      objectPath,
      (fieldValue, fieldPath) => checkInteger(fieldValue, fieldPath, 0, 0xffffffff),
    );
    checkField(
      object,
      'egid',
      objectPath,
      (fieldValue, fieldPath) => checkInteger(fieldValue, fieldPath, 0, 0xffffffff),
    );
    checkField(
      object,
      'groups',
      objectPath,
      (fieldValue, fieldPath) =>
        checkArray(
          fieldValue,
          fieldPath,
          (item, itemPath) => checkInteger(item, itemPath, 0, 0xffffffff),
          Number.MAX_SAFE_INTEGER,
        ),
    );
    checkObject(required(object, 'utility', objectPath), `${objectPath}.utility`, (utility, utilityPath) => {
      checkField(
        utility,
        'path',
        utilityPath,
        (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkText),
      );
      checkField(
        utility,
        'version',
        utilityPath,
        (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkText),
      );
      checkField(utility, 'available', utilityPath, checkBoolean);
    });
    checkObject(required(object, 'smartd', objectPath), `${objectPath}.smartd`, (smartd, smartdPath) => {
      checkField(
        smartd,
        'status',
        smartdPath,
        (fieldValue, fieldPath) => checkEnum(fieldValue, smartdValues, fieldPath),
      );
      checkField(smartd, 'checkedAt', smartdPath, checkDateTime);
      checkField(
        smartd,
        'reason',
        smartdPath,
        (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkText),
      );
    });
    checkField(
      object,
      'reasons',
      objectPath,
      (fieldValue, fieldPath) => checkArray(fieldValue, fieldPath, checkText, 16),
    );
  });
}

function checkConfig(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkSchema(object, objectPath);
    checkField(object, 'revision', objectPath, checkDecimal);
    checkField(object, 'persistentHistory', objectPath, checkBoolean);
    checkField(object, 'devices', objectPath, (fieldValue, fieldPath) =>
      checkArray(
        fieldValue,
        fieldPath,
        (item, itemPath) => {
          checkObject(item, itemPath, (deviceConfig, devicePath) => {
            checkField(deviceConfig, 'deviceId', devicePath, checkId);
            checkField(deviceConfig, 'mode', devicePath, (mode, modePath) => checkEnum(mode, modeValues, modePath));
          });
        },
        16,
      ));
  });
}

function checkPersistence(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(
      object,
      'status',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, persistenceValues, fieldPath),
    );
    checkField(
      object,
      'lastFlushAt',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkDateTime),
    );
    checkField(
      object,
      'dirtySince',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkDateTime),
    );
    checkField(
      object,
      'dataDir',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkText),
    );
  });
}

function checkSnapshot(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkSchema(object, objectPath);
    checkField(object, 'serverNow', objectPath, checkDateTime);
    checkField(
      object,
      'clockStatus',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, clockValues, fieldPath),
    );
    checkField(
      object,
      'devices',
      objectPath,
      (fieldValue, fieldPath) => checkArray(fieldValue, fieldPath, checkDevice, 16),
    );
    checkField(object, 'diagnostics', objectPath, checkDiagnostics);
    checkField(
      object,
      'config',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkConfig),
    );
    checkField(
      object,
      'persistence',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkPersistence),
    );
    checkField(object, 'truncated', objectPath, checkBoolean);
    checkField(object, 'disconnectedTruncated', objectPath, checkBoolean);
  });
}

function checkOperationResult(value: unknown, path: string, expectedKind: OperationKind): void {
  checkObject(value, path, (object, objectPath) => {
    const kind = checkField(
      object,
      'kind',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, operationKindValues, fieldPath),
    );

    if (kind !== expectedKind) {
      fail(`${objectPath}.kind`, `does not match operation kind ${expectedKind}`);
    }

    if (kind === 'discover') {
      checkField(
        object,
        'deviceIds',
        objectPath,
        (fieldValue, fieldPath) => checkArray(fieldValue, fieldPath, checkId, 16),
      );
      checkField(object, 'truncated', objectPath, checkBoolean);
      checkField(object, 'exitCode', objectPath, checkInteger);
    } else {
      checkField(object, 'deviceId', objectPath, checkId);
      checkField(object, 'exitCode', objectPath, checkInteger);
      checkField(object, 'sampleAccepted', objectPath, checkBoolean);
    }
  });
}

function checkErrorDetail(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'code', objectPath, checkText);
  });
}

function checkOperation(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkSchema(object, objectPath);
    checkField(object, 'id', objectPath, checkId);

    const kind = checkField(
      object,
      'kind',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, operationKindValues, fieldPath),
    ) as OperationKind;

    checkField(
      object,
      'deviceId',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkId),
    );

    const status = checkField(
      object,
      'status',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, operationStatusValues, fieldPath),
    ) as OperationStatus;

    checkField(object, 'createdAt', objectPath, checkDateTime);

    const completedAt = required(object, 'completedAt', objectPath);

    checkNullable(completedAt, `${objectPath}.completedAt`, checkDateTime);

    const result = required(object, 'result', objectPath);
    const error = required(object, 'error', objectPath);

    if (status === 'queued' || status === 'running') {
      if (completedAt !== null || result !== null || error !== null) {
        fail(objectPath, `${status} operation must have null completion, result, and error`);
      }

      return;
    }

    if (status === 'succeeded') {
      if (completedAt === null || result === null || error !== null) {
        fail(objectPath, 'succeeded operation requires completion and result, with null error');
      }

      checkOperationResult(result, `${objectPath}.result`, kind);

      return;
    }

    if (completedAt === null || result !== null || error === null) {
      fail(objectPath, `${status} operation requires completion and error, with null result`);
    }

    checkErrorDetail(error, `${objectPath}.error`);

    if (status === 'cancelled') {
      const errorObject = error as RecordValue;

      if (required(errorObject, 'code', `${objectPath}.error`) !== 'service-stopping') {
        fail(`${objectPath}.error.code`, 'cancelled operation must use service-stopping');
      }
    }
  });
}

function checkTemperature(value: unknown, path: string): void {
  checkNumber(value, path);

  if (value < -273.15 || value > 10000) {
    fail(path, 'temperature must be between -273.15 and 10000 degrees Celsius');
  }

  if (Math.abs(value * 1000 - Math.round(value * 1000)) >= 1e-6) {
    fail(path, 'temperature must have at most three decimal places');
  }
}

function checkTemperatureSummary(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'min', objectPath, checkTemperature);
    checkField(object, 'max', objectPath, checkTemperature);
    checkField(object, 'last', objectPath, checkTemperature);
  });
}

function checkBucket(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkField(object, 'hourStart', objectPath, checkHourStart);
    checkField(object, 'firstSampleAt', objectPath, checkDateTime);
    checkField(object, 'lastSampleAt', objectPath, checkDateTime);
    checkField(
      object,
      'sampleCount',
      objectPath,
      (fieldValue, fieldPath) => checkInteger(fieldValue, fieldPath, 0, 0xffffffff),
    );
    checkField(
      object,
      'temperatureC',
      objectPath,
      (fieldValue, fieldPath) => checkNullable(fieldValue, fieldPath, checkTemperatureSummary),
    );
    checkField(
      object,
      'counters',
      objectPath,
      checkHistoryCounters,
    );
    checkField(object, 'assessment', objectPath, checkAssessment);
  });
}

function checkHistory(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkSchema(object, objectPath);
    checkField(object, 'deviceId', objectPath, checkId);
    checkField(object, 'serverNow', objectPath, checkDateTime);

    const clockStatus = checkField(
      object,
      'clockStatus',
      objectPath,
      (fieldValue, fieldPath) => checkEnum(fieldValue, clockValues, fieldPath),
    ) as string;

    checkField(object, 'from', objectPath, checkDateTime);
    checkField(object, 'to', objectPath, checkDateTime);

    const buckets = checkField(
      object,
      'buckets',
      objectPath,
      (fieldValue, fieldPath) => checkArray(fieldValue, fieldPath, checkBucket, 720),
    ) as unknown[];

    checkField(
      object,
      'gaps',
      objectPath,
      (fieldValue, fieldPath) =>
        checkArray(fieldValue, fieldPath, (item, itemPath) => {
          checkObject(item, itemPath, (gap, gapPath) => {
            checkField(gap, 'from', gapPath, checkDateTime);
            checkField(gap, 'to', gapPath, checkDateTime);
          });
        }, 721),
    );

    const coveragePath = `${objectPath}.coverage`;
    const coverage = record(required(object, 'coverage', objectPath), coveragePath);
    const sampleCount = checkField(
      coverage,
      'sampleCount',
      coveragePath,
      (fieldValue, fieldPath) => checkInteger(fieldValue, fieldPath, 0),
    ) as number;

    const coveredSeconds = checkField(
      coverage,
      'coveredSeconds',
      coveragePath,
      (fieldValue, fieldPath) => checkInteger(fieldValue, fieldPath, 0),
    ) as number;

    checkField(
      coverage,
      'windowSeconds',
      coveragePath,
      (fieldValue, fieldPath) => checkInteger(fieldValue, fieldPath, 0),
    );

    checkField(object, 'truncated', objectPath, checkBoolean);

    const reason = checkField(
      object,
      'reason',
      objectPath,
      (fieldValue, fieldPath) =>
        checkNullable(
          fieldValue,
          fieldPath,
          (reasonValue, reasonPath) => checkEnum(reasonValue, historyReasonValues, reasonPath),
        ),
    );

    if ((clockStatus === 'invalid' || clockStatus === 'rollback') && reason !== 'clock-invalid') {
      fail(`${objectPath}.reason`, 'invalid or rollback clock requires clock-invalid reason');
    }

    if ((clockStatus === 'invalid' || clockStatus === 'rollback') && buckets.length !== 0) {
      fail(`${objectPath}.buckets`, 'invalid or rollback clock cannot include history buckets');
    }

    if ((clockStatus === 'invalid' || clockStatus === 'rollback') && sampleCount !== 0) {
      fail(`${coveragePath}.sampleCount`, 'invalid or rollback clock requires zero sample count');
    }

    if ((clockStatus === 'invalid' || clockStatus === 'rollback') && coveredSeconds !== 0) {
      fail(`${coveragePath}.coveredSeconds`, 'invalid or rollback clock requires zero covered seconds');
    }

    if (reason === 'identity-unreliable' && buckets.length !== 0) {
      fail(`${objectPath}.buckets`, 'identity-unreliable history cannot include buckets');
    }

    if (clockStatus === 'valid' && reason === 'clock-invalid') {
      fail(`${objectPath}.reason`, 'valid clock cannot use clock-invalid reason');
    }
  });
}

function checkAcceptedOperation(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkSchema(object, objectPath);
    checkField(object, 'operationId', objectPath, checkId);
  });
}

function checkApiError(value: unknown, path: string): void {
  checkObject(value, path, (object, objectPath) => {
    checkSchema(object, objectPath);
    checkField(object, 'error', objectPath, checkErrorDetail);
  });
}

export function decodeSnapshot(value: unknown): Snapshot {
  checkSnapshot(value, 'snapshot');

  return value as Snapshot;
}

export function decodeDeviceTypeResponse(value: unknown): DeviceTypeResponse {
  checkDeviceTypeResponse(value, '$');

  return value as DeviceTypeResponse;
}

export function decodeOperation(value: unknown): Operation {
  checkOperation(value, 'operation');

  return value as Operation;
}

export function decodeAcceptedOperation(value: unknown): AcceptedOperation {
  checkAcceptedOperation(value, 'acceptedOperation');

  return value as AcceptedOperation;
}

export function decodeHistory(value: unknown): HistoryResponse {
  checkHistory(value, 'history');

  return value as HistoryResponse;
}

export function decodeConfig(value: unknown): Config {
  checkConfig(value, 'config');

  return value as Config;
}

export function decodeApiError(value: unknown): ApiError {
  checkApiError(value, 'apiError');

  return value as ApiError;
}

export function encodeSettingsRequest(value: SettingsRequest): string {
  const encoded = JSON.stringify(value);

  if (encoded === undefined) {
    throw new TypeError('settings request could not be encoded');
  }

  return encoded;
}
