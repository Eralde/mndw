import type {UsbInfo, UsbInfoMap} from '../services/usb-info';
import type {Attribute, Collection, CollectionStatus, Counter, Device, Freshness, Sample} from './api';

export type CollectionResultText =
  | {kind: 'plain'; key: 'collection.ok'}
  | {kind: 'with-code'; key: 'collection.ok-with-code' | 'collection.partial'; code: number}
  | {kind: 'status-and-code'; statusKey: string; code: number | null};

export interface AssessmentSummary {
  healthKey: string;
  /** Null when the level adds nothing: an unknown level only repeats an unknown or missing health. */
  levelKey: string | null;
  reasonKeys: string[];
}

/** What the read line says about the last read: the merged one-liner, or the result with its own success line. */
export type ReadSummary =
  | {kind: 'never-read'}
  | {kind: 'result-only'; result: CollectionResultText}
  | {kind: 'succeeded'; result: CollectionResultText; at: string; stale: boolean}
  | {kind: 'attempted'; result: CollectionResultText; successAt: string | null; stale: boolean};

const DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {dateStyle: 'medium', timeStyle: 'medium'};

export function formatDecimal(value: string): string {
  return value;
}

/** Formats a wire timestamp for display; invalid input is shown verbatim. */
export function formatDateTime(value: string, locale: string | undefined): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) { return value; }

  try {
    return new Intl.DateTimeFormat(locale === '' ? undefined : locale, DATE_TIME_FORMAT).format(date);
  } catch {
    return value;
  }
}

/**
 * Maps a read result to the text it should show. A successful read hides the exit code unless it carries information:
 * bit 2 means some commands to the disk failed, other bits mean the utility reported a status the UI must show.
 */
export function collectionResult(status: CollectionStatus, exitCode: number | null): CollectionResultText {
  if (status !== 'ok') {
    return {kind: 'status-and-code', statusKey: `collection.${status}`, code: exitCode};
  }

  if (exitCode === null || exitCode === 0) {
    return {kind: 'plain', key: 'collection.ok'};
  }

  if (Math.floor(exitCode / 4) % 2 !== 0) {
    return {kind: 'with-code', key: 'collection.partial', code: exitCode};
  }

  return {kind: 'with-code', key: 'collection.ok-with-code', code: exitCode};
}

export function assessmentSummary(sample: Pick<Sample, 'health' | 'assessment'> | null): AssessmentSummary {
  if (sample === null) { return {healthKey: 'health.no-data', levelKey: null, reasonKeys: []}; }

  const {level, reasons} = sample.assessment;

  return {
    healthKey: `health.${sample.health}`,
    levelKey: level === 'unknown' ? null : `assessment.${level}`,
    reasonKeys: reasons.map((reason) => `reason.${reason}`),
  };
}

/** A read that worked and has a success time fits one line; fresh data is the normal case and needs no label. */
export function readSummary(collection: Collection, freshness: Freshness): ReadSummary {
  if (collection.status === 'never-read') { return {kind: 'never-read'}; }

  const result = collectionResult(collection.status, collection.exitCode);

  if (collection.status === 'ok') {
    // An `ok` read without a success time is rare; "no successful read" beside "read succeeded" would contradict it.
    return freshness.lastSuccessAt === null
      ? {kind: 'result-only', result}
      : {kind: 'succeeded', result, at: freshness.lastSuccessAt, stale: freshness.stale};
  }

  return {kind: 'attempted', result, successAt: freshness.lastSuccessAt, stale: freshness.stale};
}

export function formatNullable(value: string | number | null): string {
  return value === null ? '—' : String(value);
}

const BYTE_UNIT_KEYS = ['unit.b', 'unit.kb', 'unit.mb', 'unit.gb', 'unit.tb', 'unit.pb'] as const;

/** A locale the runtime does not know falls back to its default one instead of failing the whole page. */
function numberFormat(locale: string | undefined, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale === '' ? undefined : locale, options);
  } catch {
    return new Intl.NumberFormat(undefined, options);
  }
}

/** A decimal size rounded to a tenth, with the locale's units and decimal separator; null for a non-numeric value. */
export function formatBytes(
  value: string | null,
  locale: string | undefined,
  t: (key: string) => string,
): string | null {
  if (value === null || !/^\d+$/.test(value)) { return null; }

  const bytes = BigInt(value);
  let unitIndex = 0;
  let divisor = 1n;

  while (bytes >= divisor * 1000n && unitIndex < BYTE_UNIT_KEYS.length - 1) {
    divisor *= 1000n;
    unitIndex += 1;
  }

  const unit = t(BYTE_UNIT_KEYS[unitIndex] ?? 'unit.b');

  if (unitIndex === 0) { return `${numberFormat(locale).format(bytes)} ${unit}`; }

  const tenths = (bytes * 10n + divisor / 2n) / divisor;

  return `${numberFormat(locale, {maximumFractionDigits: 1}).format(Number(tenths) / 10)} ${unit}`;
}

/** The rounded size followed by the exact byte count; the dash for a missing value, the raw text for a bad one. */
export function formatCapacity(
  value: string | null,
  locale: string | undefined,
  t: (key: string) => string,
): string {
  const size = formatBytes(value, locale, t);

  if (value === null || size === null) { return formatNullable(value); }

  // Under a kilobyte the rounded size already is the exact count.
  if (BigInt(value) < 1000n) { return size; }

  return `${size} (${numberFormat(locale).format(BigInt(value))} ${t('unit.bytes')})`;
}

export function nvmeCriticalWarningBits(value: string): number[] {
  if (!/^\d+$/.test(value)) { return []; }

  const warning = BigInt(value);

  return [0x01, 0x02, 0x04, 0x08, 0x10, 0x20].filter((bit) => {
    return (warning / BigInt(bit)) % 2n !== 0n;
  });
}

const COUNTER_NAMES = new Set([
  'power_on_hours',
  'reallocated_sector_count',
  'current_pending_sector_count',
  'offline_uncorrectable_sector_count',
  'udma_crc_error_count',
  'data_units_read',
  'data_units_written',
  'media_errors',
  'unsafe_shutdowns',
  'critical_warning',
  'available_spare',
  'percentage_used',
]);
/** Counters the identity block already shows; listing them again would only repeat a row. */
const IDENTITY_COUNTERS = new Set(['power_on_hours', 'temperature']);
/** NVMe reports data in units of 1000 sectors of 512 bytes. */
const NVME_DATA_UNIT_BYTES = 512_000n;
const PLURAL_UNITS = new Set(['sectors', 'errors', 'events']);
const SECTOR_NAMES = new Set([
  'reallocated_sector_count',
  'current_pending_sector_count',
  'offline_uncorrectable_sector_count',
]);
const FAULT_COUNTER_NAMES = new Set([...SECTOR_NAMES, 'udma_crc_error_count', 'media_errors']);

/** The counters the key indicators section lists. */
export function indicatorCounters(counters: readonly Counter[]): Counter[] {
  return counters.filter((counter) => !IDENTITY_COUNTERS.has(counter.name));
}

/** A counter of sectors or errors should stay at zero, which the section explains in one line. */
export function hasFaultCounter(counters: readonly Counter[]): boolean {
  return counters.some((counter) => counter.unit === 'sectors' || counter.unit === 'errors');
}

/** The catalog key of a known counter; an unknown name has no key and is shown as it is. */
export function counterNameKey(name: string): string | null {
  return COUNTER_NAMES.has(name) ? `counter.${name}` : null;
}

function pluralCategory(count: bigint, locale: string | undefined): Intl.LDMLPluralRule {
  // Plural rules of the shipped locales read only the last digits, and `select` takes no BigInt.
  const operand = count > BigInt(Number.MAX_SAFE_INTEGER) ? Number(count % 1_000_000n) : Number(count);

  try {
    return new Intl.PluralRules(locale === '' ? undefined : locale).select(operand);
  } catch {
    return new Intl.PluralRules().select(operand);
  }
}

/** A counter value with its unit in the locale's words; a value that is not a decimal string is shown as it is. */
export function formatCounter(
  counter: Counter,
  locale: string | undefined,
  t: (key: string) => string,
): string {
  const {value, unit} = counter;

  if (!/^\d+$/.test(value)) { return value; }

  const count = BigInt(value);
  const number = numberFormat(locale).format(count);

  if (PLURAL_UNITS.has(unit)) { return `${number} ${t(`unit.${unit}.${pluralCategory(count, locale)}`)}`; }

  if (unit === 'hours') { return `${number} ${t('unit.hours')}`; }

  if (unit === 'percent') { return numberFormat(locale, {style: 'percent'}).format(Number(value) / 100); }

  if (unit === 'data-units') { return formatBytes(String(count * NVME_DATA_UNIT_BYTES), locale, t) ?? value; }

  if (unit === 'bitmask') {
    if (count === 0n) { return t('counter.none'); }

    const labels = nvmeCriticalWarningBits(value).map((bit) => {
      return t(`nvme-critical-warning.bit-${bit.toString(16).padStart(2, '0')}`);
    });

    return labels.length === 0 ? value : labels.join('; ');
  }

  return `${number} ${unit}`;
}

/** True for a counter whose value means wear or faults: growth of fault counters, a worn or nearly spent drive. */
export function counterNeedsAttention(counter: Counter): boolean {
  if (!/^\d+$/.test(counter.value)) { return false; }

  const value = BigInt(counter.value);

  if (FAULT_COUNTER_NAMES.has(counter.name) || counter.name === 'critical_warning') {
    return value > 0n;
  }

  if (counter.name === 'percentage_used') { return value >= 80n; }

  return counter.name === 'available_spare' && value <= 10n;
}

/** An attribute at or below its failure threshold; a zero threshold means the drive defines none. */
export function attributeFailing(attribute: Pick<Attribute, 'normalized' | 'threshold'>): boolean {
  const {normalized, threshold} = attribute;

  return normalized !== null && threshold !== null && threshold > 0 && normalized <= threshold;
}

/** The drive name the USB bridge reports, as shown on cards and in the details header. */
export function usbTitle(usb: UsbInfo | undefined): string | null {
  const title = [usb?.manufacturer, usb?.product].filter((part) => part !== null && part !== undefined).join(' ');

  return title.length > 0 ? title : null;
}

export function deviceTitle(device: Device, usbInfo: UsbInfoMap): string {
  return usbTitle(usbInfo.get(device.path)) ?? device.sample?.identity.model ?? device.path;
}

export interface UndetectedUsbDisk {
  path: string;
  title: string;
  port: string | null;
}

/** USB disks the router lists that smartctl did not report, named like the device cards. */
export function undetectedUsbDisks(usbInfo: UsbInfoMap, devices: readonly Device[]): UndetectedUsbDisk[] {
  const known = new Set(devices.map((device) => device.path));

  return [...usbInfo].filter(([path]) => !known.has(path)).map(([path, usb]) => ({
    path,
    title: usbTitle(usb) ?? path,
    port: usb.port,
  }));
}

/** The catalog key for an error code the backend or the client reported. */
export function errorMessageKey(code: string): string {
  const codes = new Set(['bad-request', 'unknown-device', 'utility-unavailable', 'request-failed']);

  return codes.has(code) ? `error.${code}` : 'error.generic';
}
