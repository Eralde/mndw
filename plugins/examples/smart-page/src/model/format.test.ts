import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import enCatalog from '../../i18n/en.json';
import ruCatalog from '../../i18n/ru.json';
import type {Attribute, Collection, Counter, Freshness, Sample, Snapshot} from './api';
import {
  assessmentSummary,
  attributeFailing,
  collectionResult,
  counterNameKey,
  counterNeedsAttention,
  formatBytes,
  formatCapacity,
  formatCounter,
  formatDateTime,
  formatDecimal,
  formatNullable,
  hasFaultCounter,
  indicatorCounters,
  nvmeCriticalWarningBits,
  readSummary,
  undetectedUsbDisks,
} from './format';

const rawTime = '2026-11-24T19:51:29.492882105Z';

describe('smart page formatting', () => {
  it('preserves decimal counter strings without numeric conversion', () => {
    expect(formatDecimal('18446744073709551615')).toBe('18446744073709551615');
  });

  it('renders absent attribute values as a dash', () => {
    expect(formatNullable(null)).toBe('—');
    expect(formatNullable(0)).toBe('0');
  });

  it.each([
    ['en', 'en'],
    ['ru', 'ru'],
  ])('formats wire timestamps with the %s locale', (_name, locale) => {
    const expected = new Intl.DateTimeFormat(locale, {dateStyle: 'medium', timeStyle: 'medium'})
      .format(new Date(rawTime));

    expect(formatDateTime(rawTime, locale)).toBe(expected);
    expect(formatDateTime(rawTime, locale)).not.toBe(rawTime);
  });

  it('falls back to the runtime default locale', () => {
    const expected = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'medium'})
      .format(new Date(rawTime));

    expect(formatDateTime(rawTime, undefined)).toBe(expected);
  });

  it.each(['not-a-date', '', '2026-13-45T99:99:99Z'])('returns invalid timestamp input verbatim', (value) => {
    expect(formatDateTime(value, 'en')).toBe(value);
  });

  it.each(
    [
      ['ok', 0, {kind: 'plain', key: 'collection.ok'}],
      ['ok', null, {kind: 'plain', key: 'collection.ok'}],
      ['ok', 4, {kind: 'with-code', key: 'collection.partial', code: 4}],
      ['ok', 2, {kind: 'with-code', key: 'collection.ok-with-code', code: 2}],
      ['sleeping', 7, {kind: 'status-and-code', statusKey: 'collection.sleeping', code: 7}],
      ['command-failed', null, {kind: 'status-and-code', statusKey: 'collection.command-failed', code: null}],
    ] as const,
  )('describes a %s read with smartctl exit code %s', (status, code, expected) => {
    expect(collectionResult(status, code)).toEqual(expected);
  });

  it.each(
    [
      ['no sample', null, {healthKey: 'health.no-data', levelKey: null, reasonKeys: []}],
      ['an unknown level hides the level label', {health: 'unknown',
        assessment: {level: 'unknown', reasons: ['no-health-data']}}, {healthKey: 'health.unknown', levelKey: null,
        reasonKeys: ['reason.no-health-data']}],
      [
        'a known level is shown',
        {health: 'passed', assessment: {level: 'normal', reasons: ['no-applicable-warning']}},
        {healthKey: 'health.passed', levelKey: 'assessment.normal', reasonKeys: ['reason.no-applicable-warning']},
      ],
      ['several reasons keep their order', {health: 'failed',
        assessment: {level: 'critical', reasons: ['smart-health-failed', 'ata-pending-sectors']}}, {
        healthKey: 'health.failed',
        levelKey: 'assessment.critical',
        reasonKeys: ['reason.smart-health-failed', 'reason.ata-pending-sectors'],
      }],
    ] as const,
  )('summarizes the assessment: %s', (_name, sample, expected) => {
    expect(assessmentSummary(sample as unknown as Pick<Sample, 'health' | 'assessment'> | null)).toEqual(expected);
  });

  describe('read summary', () => {
    const at = '2026-11-25T11:47:26Z';
    const collection = (status: Collection['status'], exitCode: number | null = null): Collection => ({status,
      exitCode});
    const freshness = (lastSuccessAt: string | null, stale = false): Freshness => ({lastAttemptAt: null, lastSuccessAt,
      stale});

    it.each(
      [
        ['a fresh read', collection('ok', 0), freshness(at), {kind: 'succeeded',
          result: {kind: 'plain', key: 'collection.ok'}, at, stale: false}],
        ['a stale read', collection('ok', 0), freshness(at, true), {kind: 'succeeded',
          result: {kind: 'plain', key: 'collection.ok'}, at, stale: true}],
        ['a read with a smartctl code', collection('ok', 2), freshness(at), {kind: 'succeeded',
          result: {kind: 'with-code', key: 'collection.ok-with-code', code: 2}, at, stale: false}],
        ['an ok read without a success time shows only its result', collection('ok', 0), freshness(null), {
          kind: 'result-only',
          result: {kind: 'plain', key: 'collection.ok'},
        }],
        ['a drive never read', collection('never-read'), freshness(null), {kind: 'never-read'}],
        ['a failed read after an earlier success', collection('timeout'), freshness(at, true), {kind: 'attempted',
          result: {kind: 'status-and-code', statusKey: 'collection.timeout', code: null}, successAt: at, stale: true}],
        ['a failed read with no success yet', collection('command-failed', 1), freshness(null), {kind: 'attempted',
          result: {kind: 'status-and-code', statusKey: 'collection.command-failed', code: 1}, successAt: null,
          stale: false}],
      ] as const,
    )('describes %s', (_name, status, time, expected) => {
      expect(readSummary(status, time)).toEqual(expected);
    });
  });

  describe('sizes in the page locale', () => {
    const catalogs: Record<string, Record<string, unknown>> = {en: enCatalog, ru: ruCatalog};
    const unit = (locale: string) => (key: string): string => String(catalogs[locale]?.[key]);
    // Digit groups use a no-break space in Russian; the test cares about the grouping, not which space it is.
    const plain = (value: string | null): string | null => value?.replaceAll(/\s/g, ' ') ?? null;

    it.each([
      ['en', '2000398934016', '2 TB'],
      ['ru', '2000398934016', '2 ТБ'],
      ['en', '1500000000000', '1.5 TB'],
      ['ru', '1500000000000', '1,5 ТБ'],
      ['ru', '500000000', '500 МБ'],
      ['ru', '1500', '1,5 КБ'],
      ['ru', '999', '999 Б'],
      ['en', '1000', '1 KB'],
      ['en', '0', '0 B'],
      ['ru', '0', '0 Б'],
      ['ru', '2500000000000000', '2,5 ПБ'],
      // Above 2^53 a Number would lose the low digits; the unit and its tenth must still be right.
      ['en', '9007199254740993000', '9,007.2 PB'],
      ['en', 'invalid', null],
      ['en', null, null],
    ])('formats %s byte size %s for compact display', (locale, value, expected) => {
      expect(plain(formatBytes(value, locale, unit(locale)))).toBe(expected);
    });

    it.each([
      ['en', '2000365289472', '2 TB (2,000,365,289,472 bytes)'],
      ['ru', '2000365289472', '2 ТБ (2 000 365 289 472 байт)'],
      ['ru', '18446744073709551615', '18 446,7 ПБ (18 446 744 073 709 551 615 байт)'],
      ['en', '512', '512 B'],
      ['ru', null, '—'],
      ['ru', 'unknown', 'unknown'],
    ])('adds the exact byte count to the capacity: %s %s', (locale, value, expected) => {
      expect(plain(formatCapacity(value, locale, unit(locale)))).toBe(expected);
    });
  });

  it.each([
    ['1', [0x01]],
    ['2', [0x02]],
    ['4', [0x04]],
    ['8', [0x08]],
    ['16', [0x10]],
    ['32', [0x20]],
    ['35', [0x01, 0x02, 0x20]],
    ['18446744073709551615', [0x01, 0x02, 0x04, 0x08, 0x10, 0x20]],
    ['0', []],
    ['invalid', []],
  ])('decodes NVMe warning bits from decimal value %s', (value, expected) => {
    expect(nvmeCriticalWarningBits(value)).toEqual(expected);
  });

  describe('counters', () => {
    const catalogs: Record<string, Record<string, unknown>> = {en: enCatalog, ru: ruCatalog};
    const text = (locale: string) => (key: string): string => String(catalogs[locale]?.[key]);
    const counter = (name: string, unit: string, value: string): Counter => ({name, unit, value});
    const plain = (value: string): string => value.replaceAll(/\s/g, ' ');

    it.each(
      [
        // Russian picks one / few / many by the last digits, English only one / other.
        ...[
          ['0', 'секторов'],
          ['1', 'сектор'],
          ['2', 'сектора'],
          ['5', 'секторов'],
          ['11', 'секторов'],
          ['21', 'сектор'],
          ['22', 'сектора'],
        ].map(([value, word]) => ['ru', 'sectors', value, `${value} ${word}`] as const),
        ['en', 'sectors', '0', '0 sectors'],
        ['en', 'sectors', '1', '1 sector'],
        ['ru', 'errors', '0', '0 ошибок'],
        ['ru', 'errors', '1', '1 ошибка'],
        ['ru', 'errors', '3', '3 ошибки'],
        ['en', 'errors', '1', '1 error'],
        ['en', 'errors', '2', '2 errors'],
        ['ru', 'events', '0', '0 раз'],
        ['ru', 'events', '1', '1 раз'],
        ['ru', 'events', '3', '3 раза'],
        ['en', 'events', '1', '1 time'],
        ['en', 'events', '3', '3 times'],
        ['ru', 'sectors', '1000', '1 000 секторов'],
        // Above 2^53 a Number would lose the last digits the plural form depends on.
        ['ru', 'sectors', '18446744073709551621', '18 446 744 073 709 551 621 сектор'],
        ['ru', 'hours', '888', '888 ч'],
        ['en', 'hours', '888', '888 h'],
        ['ru', 'percent', '3', '3 %'],
        ['en', 'percent', '3', '3%'],
        ['ru', 'percent', '100', '100 %'],
        // 1000 sectors of 512 bytes each.
        ['ru', 'data-units', '24000000', '12,3 ТБ'],
        ['en', 'data-units', '24000000', '12.3 TB'],
        ['en', 'data-units', '0', '0 B'],
        ['en', 'data-units', '18446744073709551615', '9,444,732,965.7 PB'],
        ['ru', 'bitmask', '0', 'Нет'],
        ['en', 'bitmask', '0', 'None'],
        ['en', 'bitmask', '3', 'Available spare is below threshold; Temperature threshold exceeded'],
        // A bit the page has no label for would leave an empty cell.
        ['en', 'bitmask', '64', '64'],
        ['ru', 'sectors', 'many', 'many'],
        ['en', 'percent', '12.5', '12.5'],
        ['en', 'hours', '-1', '-1'],
        ['en', 'widgets', '7', '7 widgets'],
      ] as const,
    )('writes a %s %s counter with value %s as "%s"', (locale, unit, value, expected) => {
      expect(plain(formatCounter(counter('any', unit, value), locale, text(locale)))).toBe(expected);
    });

    it.each(
      [
        ['reallocated_sector_count', '0', false],
        ['reallocated_sector_count', '1', true],
        ['current_pending_sector_count', '1', true],
        ['offline_uncorrectable_sector_count', '1', true],
        ['offline_uncorrectable_sector_count', '18446744073709551615', true],
        ['media_errors', '0', false],
        ['media_errors', '1', true],
        ['critical_warning', '0', false],
        ['critical_warning', '4', true],
        ['percentage_used', '79', false],
        ['percentage_used', '80', true],
        ['available_spare', '11', false],
        ['available_spare', '10', true],
        // Counters without a rule, and values that are not decimal strings, never mark a row.
        ['udma_crc_error_count', '0', false],
        ['udma_crc_error_count', '1', true],
        ['unsafe_shutdowns', '9', false],
        ['reallocated_sector_count', 'many', false],
      ] as const,
    )('flags %s = %s: %s', (name, value, expected) => {
      expect(counterNeedsAttention(counter(name, 'any', value))).toBe(expected);
    });

    it.each(
      [
        ['both at the threshold', 5, 5, true],
        ['below the threshold', 4, 5, true],
        ['above the threshold', 6, 5, false],
        ['a zero threshold', 0, 0, false],
        ['a missing threshold', 5, null, false],
        ['a missing normalized value', null, 5, false],
      ] as const,
    )('marks an attribute with %s as failing: %s', (_name, normalized, threshold, expected) => {
      const attribute: Pick<Attribute, 'normalized' | 'threshold'> = {normalized, threshold};

      expect(attributeFailing(attribute)).toBe(expected);
    });

    it('leaves out counters the identity block shows and names the known ones', () => {
      const counters = [
        counter('power_on_hours', 'hours', '1'),
        counter('temperature', 'celsius', '30'),
        counter('media_errors', 'errors', '0'),
      ];

      expect(indicatorCounters(counters).map((item) => item.name)).toEqual(['media_errors']);
      expect(counterNameKey('media_errors')).toBe('counter.media_errors');
      expect(counterNameKey('vendor_specific')).toBeNull();
      expect(hasFaultCounter(counters)).toBe(true);
      expect(hasFaultCounter([counter('available_spare', 'percent', '100')])).toBe(false);
    });
  });

  it('lists only USB disks the snapshot lacks, named like the device cards', () => {
    const {devices} = JSON.parse(readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8')) as Snapshot;
    const usb = {manufacturer: null, product: null, usbVersion: null, sizeBytes: null};

    expect(undetectedUsbDisks(
      new Map([
        ['/dev/sda', {...usb, manufacturer: 'Samsung', port: '1'}],
        ['/dev/sdb', {...usb, manufacturer: 'WD', product: 'Elements', port: '2'}],
        ['/dev/sdc', {...usb, port: null}],
      ]),
      devices,
    )).toEqual([
      {path: '/dev/sdb', title: 'WD Elements', port: '2'},
      {path: '/dev/sdc', title: '/dev/sdc', port: null},
    ]);
  });
});
