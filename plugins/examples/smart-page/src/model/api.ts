export type Id = string;
export type Text = string;
export type DateTime = string;

export type Health = 'passed' | 'failed' | 'unknown';
export type Level = 'critical' | 'warning' | 'normal' | 'unknown';
export type Reason =
  | 'smart-health-failed'
  | 'ata-current-threshold-failure'
  | 'nvme-critical-warning'
  | 'nvme-spare-below-threshold'
  | 'nvme-percentage-used'
  | 'ata-pending-sectors'
  | 'ata-uncorrectable-sectors'
  | 'no-health-data'
  | 'no-applicable-warning';
export type CollectionStatus =
  | 'ok'
  | 'sleeping'
  | 'unsupported'
  | 'permission-denied'
  | 'timeout'
  | 'invalid-output'
  | 'command-failed'
  | 'disconnected'
  | 'never-read';
export type Mode = 'off' | 'allow-wake' | 'standby-only';
export type PollingStatus = 'active' | 'needs-validation' | 'suspended';
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type OperationKind = 'discover' | 'refresh';
export type SmartdStatus = 'detected' | 'not-detected' | 'unknown';
export type ClockStatus = 'valid' | 'invalid' | 'rollback';
export type PersistenceStatus = 'enabled' | 'disabled' | 'degraded';
export type Protocol = 'ata' | 'nvme' | 'scsi' | 'unknown';
export type BindingStatus = 'provisional' | 'validated' | 'disconnected';
export type DeviceTypeSource = 'scan' | 'user';
export type DeviceTypeOverride = 'sat' | 'scsi' | 'nvme' | 'sntasmedia' | 'sntjmicron' | 'sntrealtek';
export type HistoryReason = 'identity-unreliable' | 'clock-invalid';

export interface Assessment {
  level: Level;
  reasons: Reason[];
  rulesVersion: 1;
}

export interface Identity {
  reliable: boolean;
  model: Text | null;
  serial: Text | null;
  wwn: Text | null;
  capacityBytes: string | null;
}

export interface Counter {
  name: Text;
  value: string;
  unit: Text;
}

export type HistoryCounter = Counter;

export interface Attribute {
  id: number | null;
  name: Text;
  raw: Text | null;
  normalized: number | null;
  threshold: number | null;
}

export interface Capabilities {
  attributes: boolean;
  temperature: boolean;
  standbyOnlyValidated: boolean;
}

export interface Sample {
  schemaVersion: 1;
  deviceId: Id;
  sampledAt: DateTime;
  protocol: Protocol;
  identity: Identity;
  temperatureC: number | null;
  powerOnHours: string | null;
  rotationRate: number | null;
  health: Health;
  assessment: Assessment;
  counters: Counter[];
  capabilities: Capabilities;
  attributes: Attribute[];
}

export interface Collection {
  status: CollectionStatus;
  exitCode: number | null;
}

export interface Freshness {
  lastAttemptAt: DateTime | null;
  lastSuccessAt: DateTime | null;
  stale: boolean;
}

export interface Polling {
  mode: Mode;
  status: PollingStatus;
  nextDue: DateTime | null;
}

export interface Device {
  deviceId: Id;
  path: Text;
  deviceType: Text;
  deviceTypeSource: DeviceTypeSource;
  usbBridge: Text | null;
  binding: BindingStatus;
  sample: Sample | null;
  collection: Collection;
  freshness: Freshness;
  polling: Polling | null;
  truncated: boolean;
}

export interface DeviceTypeResponse {
  schemaVersion: 1;
  deviceId: Id;
  deviceType: Text;
  deviceTypeSource: DeviceTypeSource;
}

export interface UtilityDiagnostic {
  path: Text | null;
  version: Text | null;
  available: boolean;
}

export interface SmartdDiagnostic {
  status: SmartdStatus;
  checkedAt: DateTime;
  reason: Text | null;
}

export interface Diagnostics {
  checkedAt: DateTime;
  euid: number;
  egid: number;
  groups: number[];
  utility: UtilityDiagnostic;
  smartd: SmartdDiagnostic;
  reasons: Text[];
}

export interface Persistence {
  status: PersistenceStatus;
  lastFlushAt: DateTime | null;
  dirtySince: DateTime | null;
  dataDir: Text | null;
}

export interface Snapshot {
  schemaVersion: 1;
  serverNow: DateTime;
  clockStatus: ClockStatus;
  devices: Device[];
  diagnostics: Diagnostics;
  config: Config | null;
  persistence: Persistence | null;
  truncated: boolean;
  disconnectedTruncated: boolean;
}

export interface DiscoverResult {
  kind: 'discover';
  deviceIds: Id[];
  truncated: boolean;
  exitCode: number;
}

export interface RefreshResult {
  kind: 'refresh';
  deviceId: Id;
  exitCode: number;
  sampleAccepted: boolean;
}

export type OperationResult = DiscoverResult | RefreshResult;

export interface ErrorDetail {
  code: Text;
}

export interface Operation {
  schemaVersion: 1;
  id: Id;
  kind: OperationKind;
  deviceId: Id | null;
  status: OperationStatus;
  createdAt: DateTime;
  completedAt: DateTime | null;
  result: OperationResult | null;
  error: ErrorDetail | null;
}

export interface AcceptedOperation {
  schemaVersion: 1;
  operationId: Id;
}

export interface ApiError {
  schemaVersion: 1;
  error: ErrorDetail;
}

export interface DeviceConfig {
  deviceId: Id;
  mode: Mode;
}

export interface Config {
  schemaVersion: 1;
  revision: string;
  persistentHistory: boolean;
  devices: DeviceConfig[];
}

export interface SettingsDevice {
  deviceId: Id;
  mode: Mode;
  acknowledgeWake?: boolean;
  acknowledgeSleepValidation?: boolean;
}

export interface SettingsRequest {
  expectedRevision: string;
  persistentHistory: boolean;
  devices: SettingsDevice[];
}

export interface TemperatureSummary {
  min: number;
  max: number;
  last: number;
}

export interface Bucket {
  hourStart: DateTime;
  firstSampleAt: DateTime;
  lastSampleAt: DateTime;
  sampleCount: number;
  temperatureC: TemperatureSummary | null;
  counters: HistoryCounter[];
  assessment: Assessment;
}

export interface TimeRange {
  from: DateTime;
  to: DateTime;
}

export interface Coverage {
  sampleCount: number;
  coveredSeconds: number;
  windowSeconds: number;
}

export interface HistoryResponse {
  schemaVersion: 1;
  deviceId: Id;
  serverNow: DateTime;
  clockStatus: ClockStatus;
  from: DateTime;
  to: DateTime;
  buckets: Bucket[];
  gaps: TimeRange[];
  coverage: Coverage;
  truncated: boolean;
  reason: HistoryReason | null;
}
