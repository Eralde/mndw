import {readFileSync} from 'node:fs';
import {flushSync, mount, settled, unmount} from 'svelte';
import type {PluginI18n} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {describe, expect, it} from 'vitest';
import enCatalog from '../../i18n/en.json';
import ruCatalog from '../../i18n/ru.json';
import type {Device, DeviceTypeOverride, Operation, Snapshot} from '../model/api';
import type {BackendAvailability, PageNotice, PageState} from '../services/page-controller';
import type {UsbInfoMap} from '../services/usb-info';
import DeviceDetails from './DeviceDetails.svelte';
import Diagnostics from './Diagnostics.svelte';
import DeviceList from './DeviceList.svelte';
import NoDevices from './NoDevices.svelte';
import PageNoticeComponent from './PageNotice.svelte';
import WakeConsentDialog from './WakeConsentDialog.svelte';

type View = 'list' | 'details' | 'diagnostics' | 'empty' | 'wake';
type Sample = NonNullable<Device['sample']>;
type Backend = BackendAvailability;
type Health = Sample['health'];
type AssessmentReason = Sample['assessment']['reasons'][number];
type Freshness = 'current' | 'stale' | 'unread';
type SmartdReason = Exclude<Snapshot['diagnostics']['smartd']['reason'], null>;
type DiagnosticReason = Snapshot['diagnostics']['reasons'][number];
type Setter<T> = (stateValue: PageState, value: T) => void;
type Locale = 'en' | 'ru';
// Plural forms differ by language: a case lists the locales whose rules pick these keys.
type MatrixCase =
  | {view: View; state: PageState; keys: readonly string[]; usbInfo?: UsbInfoMap; locales?: readonly Locale[]}
  | {view: 'notice'; notice: PageNotice; keys: readonly string[]; locales?: readonly Locale[]};

const enumValues = <T extends string>(items: string): readonly T[] => items.split(' ') as T[];
const catalogs: Record<Locale, Record<string, unknown>> = {en: enCatalog, ru: ruCatalog};
const fixture = JSON.parse(readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8')) as Snapshot;
const deviceTypes = enumValues<DeviceTypeOverride>('sat scsi nvme sntasmedia sntjmicron sntrealtek');
const values = {
  backend: enumValues<Backend>('unknown available unknown-id not-approved disabled starting unavailable incompatible'),
  health: enumValues<Health>('passed failed unknown'),
  assessment: enumValues<Sample['assessment']['level']>('critical warning normal unknown'),
  reasons: enumValues<AssessmentReason>(
    'smart-health-failed ata-current-threshold-failure nvme-critical-warning nvme-spare-below-threshold '
      + 'nvme-percentage-used ata-pending-sectors ata-uncorrectable-sectors no-health-data no-applicable-warning',
  ),
  collection: enumValues<Device['collection']['status']>(
    'ok sleeping unsupported permission-denied timeout invalid-output command-failed disconnected never-read',
  ),
  protocol: enumValues<Sample['protocol']>('ata nvme scsi unknown'),
  operationStatus: enumValues<Operation['status']>('queued running succeeded failed cancelled'),
  typeSource: enumValues<Device['deviceTypeSource']>('scan user'),
  smartd: enumValues<Snapshot['diagnostics']['smartd']['status']>('detected not-detected unknown'),
  freshness: enumValues<Freshness>('current stale unread'),
  smartdReason: enumValues<SmartdReason>('process-view-unavailable process-view-incomplete'),
  diagnosticReason: enumValues<DiagnosticReason>('groups-unavailable discovery-not-run unknown-reason'),
};

function state(): PageState {
  const snapshot = structuredClone(fixture);

  return {selectedDeviceId: snapshot.devices[0]?.deviceId ?? null, snapshot, operation: null,
    backendAvailability: 'available', notice: null, wakeConsentGranted: false, wakeConsentKeys: new Set(),
    wakeConfirmationRequired: true, emptyState: null};
}

function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) { throw new Error(`fixture ${name} is missing`); }

  return value;
}

const device = (stateValue: PageState): Device => required(stateValue.snapshot?.devices[0], 'device');
const sample = (stateValue: PageState): Sample => required(device(stateValue).sample, 'sample');
const snapshot = (stateValue: PageState): Snapshot => required(stateValue.snapshot, 'snapshot');

function scenario(
  view: View,
  keys: readonly string[],
  update: (stateValue: PageState) => void = () => {},
): MatrixCase {
  const stateValue = state();

  update(stateValue);

  return {view, keys, state: stateValue};
}

const addValues = <T extends string>(
  view: View,
  items: readonly T[],
  update: (stateValue: PageState, value: T) => void,
  key: string | ((value: T) => string),
): MatrixCase[] =>
  items.map((value) =>
    scenario(view, [typeof key === 'string' ? `${key}${value}` : key(value)], (stateValue) => update(stateValue, value))
  );

function field<T, K extends keyof T>(get: (stateValue: PageState) => T, key: K): Setter<T[K]> {
  return (stateValue, value) => get(stateValue)[key] = value;
}

function makeOperation(kind: Operation['kind'], status: Operation['status']): Operation {
  return {schemaVersion: 1, id: 'op-1', kind, deviceId: null, status, createdAt: '2026-11-24T11:59:57Z',
    completedAt: null, result: null, error: null};
}

const setAssessmentReason: Setter<AssessmentReason> = (stateValue, value) =>
  sample(stateValue).assessment.reasons = [value];
const setCollectionStatus: Setter<Device['collection']['status']> = (stateValue, value) =>
  device(stateValue).collection.status = value;
const setOperationKind: Setter<Operation['kind']> = (stateValue, value) =>
  stateValue.operation = makeOperation(value, 'queued');
const setOperationStatus: Setter<Operation['status']> = (stateValue, value) =>
  stateValue.operation = makeOperation('discover', value);
const setEmpty = (empty: NonNullable<PageState['emptyState']>) => (stateValue: PageState): void => {
  snapshot(stateValue).devices = [];
  stateValue.emptyState = empty;
};
const setSmartdStatus: Setter<Snapshot['diagnostics']['smartd']['status']> = (stateValue, value) =>
  snapshot(stateValue).diagnostics.smartd.status = value;
const setFreshness: Setter<Freshness> = (stateValue, value) => {
  device(stateValue).freshness = {
    ...device(stateValue).freshness,
    lastSuccessAt: value === 'unread' ? null : '2026-11-24T11:59:57Z',
    stale: value !== 'current',
  };

  // An `ok` read without a success time shows only its result; the "no successful read" line belongs to a failure.
  if (value === 'unread') { device(stateValue).collection.status = 'timeout'; }
};
const setSmartdReason: Setter<SmartdReason> = (stateValue, value) =>
  snapshot(stateValue).diagnostics.smartd.reason = value.replaceAll('-', ' ');
const setDiagnosticReason: Setter<DiagnosticReason> = (stateValue, value) =>
  snapshot(stateValue).diagnostics.reasons = [value];
const freshnessKey = (value: Freshness): string =>
  ({current: 'collection.ok', stale: 'freshness.older-than-60-minutes', unread: 'freshness.no-successful-read-yet'})[
    value
  ];
// Without an operation of ours, the snapshot decides; the matrix fixture says discovery ran.
const discoveryKey = (value: Operation['status']): string =>
  ({queued: 'discovery.searching', running: 'discovery.searching', succeeded: 'discovery.finished',
    failed: 'discovery.failed', cancelled: 'discovery.finished'})[value];
const diagnosticKey = (value: DiagnosticReason): string =>
  value === 'discovery-not-run'
    ? value
    : value === 'unknown-reason'
    ? 'diagnostics.other-reason'
    : `diagnostics.${value}`;

type Counters = Sample['counters'];

const counterScenario = (
  counters: Counters,
  keys: readonly string[],
  locales?: readonly Locale[],
): MatrixCase => ({
  ...scenario('details', keys, (stateValue) => sample(stateValue).counters = counters),
  ...(locales === undefined ? {} : {locales}),
});

function makeMatrix(): MatrixCase[] {
  const cases: MatrixCase[] = [
    // An available backend shows no status line.
    ...values.backend.filter((value) => value !== 'available').map((value) =>
      scenario(
        'list',
        [value === 'unknown' ? 'backend.checking' : `backend.${value}`],
        (stateValue) => stateValue.backendAvailability = value,
      )
    ),
    scenario('list', ['read.not-yet'], (stateValue) => device(stateValue).sample = null),
    ...addValues('list', values.health, field(sample, 'health'), 'health.'),
    // The cards and the details name every level except an unknown one, which only repeats an unknown health.
    ...addValues(
      'list',
      values.assessment.filter((level) => level !== 'unknown'),
      field((s: PageState) => sample(s).assessment, 'level'),
      'assessment.',
    ),
    ...addValues(
      'details',
      values.assessment.filter((level) => level !== 'unknown'),
      field((s: PageState) => sample(s).assessment, 'level'),
      'assessment.',
    ),
    ...addValues('details', values.reasons, setAssessmentReason, 'reason.'),
    ...addValues('details', values.collection, setCollectionStatus, 'collection.'),
    ...addValues('details', values.protocol, field(sample, 'protocol'), 'protocol.'),
    ...addValues('details', ['refresh'], setOperationKind, 'operation.'),
    ...addValues('list', values.operationStatus, setOperationStatus, discoveryKey),
    scenario('list', ['discovery.last-search'], (stateValue) => {
      stateValue.operation = {...makeOperation('discover', 'succeeded'), completedAt: '2026-11-24T11:59:57Z'};
    }),
    scenario(
      'list',
      ['discovery.never'],
      (stateValue) => snapshot(stateValue).diagnostics.reasons = ['discovery-not-run'],
    ),
    scenario('list', ['discovery.failed'], setEmpty({kind: 'failed', code: 'request-failed'})),
    ...addValues('details', values.typeSource, field(device, 'deviceTypeSource'), 'device-type.source.'),
    ...addValues('diagnostics', values.smartd, setSmartdStatus, 'diagnostics.smartd-'),
    ...addValues('details', values.freshness, setFreshness, freshnessKey),
    scenario('details', ['collection.label', 'freshness.last-success'], (stateValue) => {
      device(stateValue).collection.status = 'timeout';
    }),
    scenario('diagnostics', ['diagnostics.utility', 'diagnostics.utility-path', 'diagnostics.utility-version']),
    scenario('wake', ['action.remember-wake-consent', 'action.cancel', 'action.confirm-refresh']),
    ...addValues('diagnostics', values.smartdReason, setSmartdReason, (value) => `diagnostics.smartd-reason.${value}`),
    ...addValues('diagnostics', values.diagnosticReason, setDiagnosticReason, diagnosticKey),
    scenario('list', ['discovery.searching'], setEmpty({kind: 'searching'})),
    counterScenario(
      [
        {name: 'reallocated_sector_count', value: '1', unit: 'sectors'},
        {name: 'current_pending_sector_count', value: '0', unit: 'sectors'},
        {name: 'offline_uncorrectable_sector_count', value: '0', unit: 'sectors'},
        {name: 'udma_crc_error_count', value: '1', unit: 'errors'},
        {name: 'unsafe_shutdowns', value: '1', unit: 'events'},
        {name: 'power_on_hours_total', value: '1', unit: 'hours'},
      ],
      [
        'details.drive',
        'details.indicators',
        'counter.reallocated_sector_count',
        'counter.current_pending_sector_count',
        'counter.offline_uncorrectable_sector_count',
        'counter.udma_crc_error_count',
        'counter.unsafe_shutdowns',
        'counter.hint',
        'flag.attention',
        'unit.sectors.one',
        'unit.errors.one',
        'unit.events.one',
        'unit.hours',
      ],
    ),
    counterScenario(
      [
        {name: 'a', value: '2', unit: 'sectors'},
        {name: 'b', value: '2', unit: 'errors'},
        {name: 'c', value: '2', unit: 'events'},
      ],
      ['unit.sectors.other', 'unit.errors.other', 'unit.events.other'],
      ['en'],
    ),
    counterScenario(
      [
        {name: 'a', value: '2', unit: 'sectors'},
        {name: 'b', value: '2', unit: 'errors'},
        {name: 'c', value: '2', unit: 'events'},
        {name: 'd', value: '5', unit: 'sectors'},
        {name: 'e', value: '5', unit: 'errors'},
        {name: 'f', value: '5', unit: 'events'},
      ],
      [
        'unit.sectors.few',
        'unit.sectors.many',
        'unit.errors.few',
        'unit.errors.many',
        'unit.events.few',
        'unit.events.many',
      ],
      ['ru'],
    ),
    counterScenario(
      [
        {name: 'data_units_read', value: '24000000', unit: 'data-units'},
        {name: 'data_units_written', value: '1', unit: 'data-units'},
        {name: 'media_errors', value: '0', unit: 'errors'},
        {name: 'critical_warning', value: '3', unit: 'bitmask'},
        {name: 'available_spare', value: '100', unit: 'percent'},
        {name: 'percentage_used', value: '3', unit: 'percent'},
      ],
      [
        'counter.data_units_read',
        'counter.data_units_written',
        'counter.media_errors',
        'counter.critical_warning',
        'counter.available_spare',
        'counter.percentage_used',
        'unit.tb',
        'unit.kb',
        'nvme-critical-warning.bit-01',
        'nvme-critical-warning.bit-02',
      ],
    ),
    counterScenario([{name: 'critical_warning', value: '0', unit: 'bitmask'}], ['counter.none']),
    scenario('details', ['details.placeholder'], (stateValue) => {
      stateValue.selectedDeviceId = null;
      stateValue.emptyState = {kind: 'searching'};
    }),
    scenario('empty', ['devices.empty', 'action.find-devices'], setEmpty({kind: 'never-ran'})),
    scenario('empty', ['empty.nothing-found', 'action.search-again'], setEmpty({kind: 'nothing-found'})),
    scenario('empty', ['empty.no-utility'], setEmpty({kind: 'no-utility'})),
    ...enumValues<string>('bad-request unknown-device utility-unavailable request-failed unmapped').map((code) =>
      scenario(
        'empty',
        ['empty.failed', 'action.search-again', `error.${code === 'unmapped' ? 'generic' : code}`],
        setEmpty({kind: 'failed', code}),
      )
    ),
  ];

  type RequestErrorCode = Extract<PageNotice, {kind: 'request-error'}>['code'];

  const notices: ReadonlyArray<readonly [PageNotice, string]> = [
    [{kind: 'backend-recovered'}, 'backend.recovered'],
    [{kind: 'device-not-selected'}, 'notice.device-not-selected'],
    [{kind: 'busy', code: 'busy'}, 'notice.busy'],
    [{kind: 'disconnected', code: 'disconnected', requiredAction: 'discover'}, 'notice.disconnected'],
    ...enumValues<RequestErrorCode>('bad-request unknown-device utility-unavailable request-failed unmapped').map((
      code,
    ) => [{kind: 'request-error', code}, `error.${code === 'unmapped' ? 'generic' : code}`] as const),
  ];

  const usbInfo = new Map([['/dev/sda', {
    manufacturer: 'Samsung',
    product: 'PSSD T7',
    port: '1',
    usbVersion: '3.20',
    sizeBytes: '2000398934016',
  }]]);

  return [
    ...cases,
    {
      view: 'details',
      state: state(),
      usbInfo,
      keys: ['field.usb-device', 'field.usb-port', 'field.usb-version', 'unit.tb', 'unit.bytes'],
    },
    ...notices.map(([notice, key]) => ({view: 'notice' as const, notice, keys: [key]})),
    {
      view: 'details',
      state: state(),
      keys: ['device-type.auto', ...deviceTypes.map((type) => `device-type.option.${type}`)],
    },
  ];
}

const accepted = () => Promise.resolve('accepted');

function renderCase(matrixCase: MatrixCase, target: HTMLElement, i18n: PluginI18n): ReturnType<typeof mount> {
  if (matrixCase.view === 'notice') {
    return mount(PageNoticeComponent, {target, props: {notice: matrixCase.notice, i18n}});
  }

  if (matrixCase.view === 'diagnostics') {
    return mount(Diagnostics, {target, props: {snapshot: snapshot(matrixCase.state), i18n}});
  }

  if (matrixCase.view === 'wake') {
    return mount(WakeConsentDialog, {target, props: {i18n, canRemember: true, onDecision: () => undefined}});
  }

  if (matrixCase.view === 'empty') {
    return mount(NoDevices, {target, props: {state: matrixCase.state, i18n, onDiscover: accepted}});
  }

  if (matrixCase.view === 'list') {
    return mount(DeviceList, {target, props: {state: matrixCase.state, i18n, onDiscover: accepted, onSelect: () =>
      undefined}});
  }

  return mount(DeviceDetails, {target,
    props: {state: matrixCase.state, i18n, usbInfo: matrixCase.usbInfo, onDiscover: accepted, onRefresh: accepted,
      onSetDeviceType: accepted, confirmWake: () => Promise.resolve({confirmed: false, remember: false})}});
}

describe('smart page locale enum matrix', () => {
  it.each(['en', 'ru'] as const)('renders enum labels in %s', async (locale) => {
    const catalog = catalogs[locale];
    const i18n = createTestI18n(catalog, locale);

    for (const matrixCase of makeMatrix().filter((item) => item.locales?.includes(locale) ?? true)) {
      const target = document.createElement('div');

      document.body.append(target);

      const app = renderCase(matrixCase, target, i18n);

      try {
        await settled();
        flushSync();

        for (const key of matrixCase.keys) {
          const expectedValue = catalog[key];
          const expected = typeof expectedValue === 'string' ? expectedValue : undefined;

          if (expected === undefined) { throw new Error(`missing ${locale} catalog key: ${key}`); }

          expect(target.textContent, `${locale}: ${matrixCase.keys.join(', ')} (${key})`).toContain(expected);
        }
      } finally {
        await unmount(app);
        target.remove();
      }
    }
  });
});
