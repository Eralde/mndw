import {readFileSync} from 'node:fs';
import {flushSync, mount, settled, unmount} from 'svelte';
import {createTestI18n} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import enCatalog from '../../i18n/en.json';
import ruCatalog from '../../i18n/ru.json';
import type {Collection, DeviceTypeOverride, Freshness, Snapshot} from '../model/api';
import type {WakeDecision} from '../services/confirm-wake';
import type {ActionResult, PageState} from '../services/page-controller';
import type {UsbInfo} from '../services/usb-info';
import DeviceDetails from './DeviceDetails.svelte';
import DeviceDetailsSelectionHarness from './test-fixtures/DeviceDetailsSelectionHarness.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

type ConfirmWake = (canRemember: boolean, signal: AbortSignal) => Promise<WakeDecision>;

const declined: WakeDecision = {confirmed: false, remember: false};
const confirmedWith = (remember: boolean): ConfirmWake => vi.fn().mockResolvedValue({confirmed: true, remember});

function makeState(overrides: Partial<PageState> = {}): PageState {
  const snapshot = JSON.parse(readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8')) as Snapshot;

  return {
    selectedDeviceId: snapshot.devices[0]?.deviceId ?? null,
    snapshot,
    operation: null,
    backendAvailability: 'available',
    notice: null,
    wakeConsentGranted: false,
    wakeConsentKeys: new Set(),
    wakeConfirmationRequired: true,
    emptyState: null,
    ...overrides,
  };
}

const formatted = (value: string): string => {
  return new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeStyle: 'medium'}).format(new Date(value));
};

async function render(
  state: PageState,
  actions: {
    onDiscover?: (targetDeviceId: string | undefined) => Promise<ActionResult>;
    onRefresh?: (targetDeviceId: string | undefined) => Promise<ActionResult>;
    onSetDeviceType?: (deviceId: string, deviceType: DeviceTypeOverride | null) => Promise<ActionResult>;
    confirmWake?: ConfirmWake;
    locale?: 'en' | 'ru';
    usb?: Partial<UsbInfo>;
  } = {},
): Promise<void> {
  const locale = actions.locale ?? 'en';

  host = document.createElement('div');
  document.body.append(host);
  app = mount(DeviceDetails, {
    target: host,
    props: {
      state,
      i18n: createTestI18n(locale === 'ru' ? ruCatalog : enCatalog, locale),
      locale,
      usbInfo: actions.usb === undefined
        ? undefined
        : new Map([['/dev/sda', {manufacturer: null, product: null, port: null, usbVersion: null, sizeBytes: null,
          ...actions.usb}]]),
      onDiscover: actions.onDiscover ?? vi.fn().mockResolvedValue('accepted'),
      onRefresh: actions.onRefresh ?? vi.fn().mockResolvedValue('accepted'),
      onSetDeviceType: actions.onSetDeviceType ?? vi.fn().mockResolvedValue('accepted'),
      confirmWake: actions.confirmWake ?? vi.fn().mockResolvedValue(declined),
    },
  });
  await settled();
  flushSync();
}

async function renderSelectionHarness(
  state: PageState,
  onRefresh: (targetDeviceId: string | undefined) => Promise<ActionResult> = vi.fn().mockResolvedValue('accepted'),
  onSetDeviceType: (deviceId: string, deviceType: DeviceTypeOverride | null) => Promise<ActionResult> = vi.fn()
    .mockResolvedValue('accepted'),
  confirmWake: ConfirmWake = vi.fn().mockResolvedValue(declined),
  onFocusLost?: () => void,
): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  app = mount(DeviceDetailsSelectionHarness, {
    target: host,
    props: {
      initialState: state,
      i18n: createTestI18n(enCatalog),
      onDiscover: vi.fn().mockResolvedValue('accepted'),
      onRefresh,
      onSetDeviceType,
      confirmWake,
      onFocusLost,
    },
  });
  await settled();
  flushSync();
}

function makeTwoDeviceState(): PageState {
  const state = makeState();

  if (state.snapshot?.devices[0] === undefined) {
    throw new Error('fixture device is missing');
  }

  const first = state.snapshot.devices[0];
  const second = structuredClone(first);

  second.deviceId = 'dev-b';
  second.path = '/dev/sdb';

  if (second.sample !== null) {
    second.sample = {...second.sample, deviceId: 'dev-b'};
    second.sample.identity.model = 'Second device';
  }

  state.snapshot.devices = [first, second];

  return state;
}

function changeSelectValue(select: HTMLElement | null, value: string): void {
  select?.dispatchEvent(
    new CustomEvent('mndwchange', {
      bubbles: true,
      composed: true,
      detail: {value},
    }),
  );
}

afterEach(() => {
  if (app !== null) {
    void unmount(app);
    app = null;
  }

  host?.remove();
});

describe('DeviceDetails', () => {
  it('shows the power-on hours as an exact decimal in the drive details, not in the indicators', async () => {
    await render(makeState());

    expect(host.querySelector('.identity')?.textContent).toContain('18446744073709551615');
    expect(host.querySelector('.indicators')).toBeNull();
  });

  describe('readings', () => {
    type Sample = NonNullable<Snapshot['devices'][number]['sample']>;

    const readings = (counters: Sample['counters'], attributes?: Sample['attributes']): PageState => {
      const state = makeState();
      const sample = state.snapshot?.devices[0]?.sample;

      if (sample === null || sample === undefined) { throw new Error('fixture sample is missing'); }

      sample.counters = counters;
      sample.attributes = attributes ?? sample.attributes;

      return state;
    };
    const sat: Sample['counters'] = [
      {name: 'power_on_hours', value: '888', unit: 'hours'},
      {name: 'reallocated_sector_count', value: '0', unit: 'sectors'},
      {name: 'current_pending_sector_count', value: '0', unit: 'sectors'},
      {name: 'offline_uncorrectable_sector_count', value: '0', unit: 'sectors'},
      {name: 'udma_crc_error_count', value: '0', unit: 'errors'},
    ];
    const nvme: Sample['counters'] = [
      {name: 'data_units_read', value: '24000000', unit: 'data-units'},
      {name: 'media_errors', value: '2', unit: 'errors'},
      {name: 'unsafe_shutdowns', value: '21', unit: 'events'},
      {name: 'critical_warning', value: '4', unit: 'bitmask'},
      {name: 'available_spare', value: '100', unit: 'percent'},
      {name: 'percentage_used', value: '3', unit: 'percent'},
    ];
    const attribute = (
      id: number,
      normalized: number | null,
      threshold: number | null,
    ): Sample['attributes'][number] => ({
      id,
      name: `Attr_${id}`,
      raw: '0',
      normalized,
      threshold,
    });
    const indicatorRows = (): string[] => {
      return [...host.querySelectorAll('.indicators dt')].map((term) => {
        const value = term.nextElementSibling;

        return `${term.textContent}: ${value?.querySelector('span')?.textContent}`.replaceAll(/\s/g, ' ');
      });
    };
    const flagged = (): string[] => {
      return [...host.querySelectorAll('.indicators dd.warning')].map((value) => {
        return value.previousElementSibling?.textContent ?? '';
      });
    };

    it('names the counters of a SAT drive, keeps its zeros plain and leaves power-on hours to the drive details', async () => {
      await render(readings(sat), {locale: 'ru'});

      expect(indicatorRows()).toEqual([
        'Переназначенные сектора: 0 секторов',
        'Нестабильные сектора: 0 секторов',
        'Неисправимые сектора: 0 секторов',
        'Ошибки передачи по кабелю (CRC): 0 ошибок',
      ]);
      expect(flagged()).toEqual([]);
      expect(host.querySelector('.indicators h3')?.textContent).toBe('Ключевые показатели');
      expect(host.querySelector('.indicators p')?.textContent).toBe(
        'Для этих счётчиков норма — 0; рост значений говорит об износе или сбоях.',
      );
      expect(host.querySelector('.indicators')?.textContent).not.toContain('Часы работы');
    });

    it('writes NVMe counters with units and bit names, and marks the ones that need attention', async () => {
      await render(readings(nvme), {locale: 'ru'});

      expect(indicatorRows()).toEqual([
        'Прочитано: 12,3 ТБ',
        'Ошибки носителя: 2 ошибки',
        'Небезопасные отключения: 21 раз',
        'Критическое предупреждение: Состояние надёжности ухудшилось',
        'Резерв: 100 %',
        'Износ: 3 %',
      ]);
      expect(flagged()).toEqual(['Ошибки носителя', 'Критическое предупреждение']);
      expect(host.querySelectorAll('.indicators dd.warning .visually-hidden')).toHaveLength(2);
      expect(host.querySelector('.indicators dd.warning .visually-hidden')?.textContent?.trim()).toBe('внимание');
    });

    it('shows the hint only while a sector or error counter is listed', async () => {
      await render(readings([{name: 'available_spare', value: '100', unit: 'percent'}]), {locale: 'en'});

      expect(host.querySelector('.indicators')).not.toBeNull();
      expect(host.querySelector('.indicators p')).toBeNull();
    });

    it('omits the section when only counters of the drive details are left', async () => {
      await render(readings(sat.slice(0, 1)));

      expect(host.querySelector('.indicators')).toBeNull();
    });

    it('falls back to the raw name of a counter it does not know', async () => {
      await render(readings([{name: 'vendor_specific', value: '7', unit: 'events'}]), {locale: 'en'});

      expect(indicatorRows()).toEqual(['vendor_specific: 7 times']);
    });

    it('splits the readings into three cards and keeps the attribute table closed behind its count', async () => {
      await render(readings(sat, [attribute(5, 100, 36), attribute(9, 90, 0)]), {locale: 'ru'});

      const cards = [...host.querySelectorAll('.card')].map((card) =>
        card.classList.contains('attributes') ? 'details' : card.querySelector('h3')?.textContent
      );
      const attributes = host.querySelector<HTMLDetailsElement>('[data-testid="attributes"]');

      expect(cards).toEqual(['Сведения о диске', 'Ключевые показатели', 'details']);
      expect(attributes?.open).toBe(false);
      expect(attributes?.querySelector('summary')?.textContent).toBe('Атрибуты S.M.A.R.T. (2)');
      expect(attributes?.querySelectorAll('tbody tr')).toHaveLength(2);
    });

    it('marks an attribute at or below its threshold and none else', async () => {
      await render(readings(sat, [attribute(5, 36, 36), attribute(9, 90, 0), attribute(10, 100, 36)]));

      const failing = [...host.querySelectorAll('tbody tr.failing')].map((row) => row.children[1]?.textContent);

      expect(failing).toEqual(['Attr_5 warning']);
    });
  });

  it('disconnected selection starts discovery without a confirmation prompt', async () => {
    const state = makeState();

    if (state.snapshot?.devices[0] === undefined) {
      throw new Error('fixture device is missing');
    }

    state.snapshot.devices[0].binding = 'disconnected';
    state.snapshot.devices[0].collection.status = 'disconnected';

    const onDiscover = vi.fn().mockResolvedValue('accepted');
    const onRefresh = vi.fn();

    await render(state, {onDiscover, onRefresh});

    expect(host.querySelector('[data-testid="refresh"]')).toBeNull();
    host.querySelector<HTMLElement>('[data-testid="find-devices"]')?.click();
    await settled();
    flushSync();
    expect(onDiscover).toHaveBeenCalledExactlyOnceWith('dev-a');
    expect(onRefresh).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="confirm-find-devices"]')).toBeNull();
  });

  it.each([
    ['a disconnected drive', true, 'Device discovery: Running'],
    ['a connected drive', false, null],
  ])('shows a running discovery for %s only where the discover button is', async (_name, disconnected, text) => {
    const state = makeState({
      operation: {schemaVersion: 1, id: 'op-1', kind: 'discover', deviceId: null, status: 'running',
        createdAt: '2026-11-24T11:59:00Z', completedAt: null, result: null, error: null},
    });
    const device = state.snapshot?.devices[0];

    if (device === undefined) { throw new Error('fixture device is missing'); }

    if (disconnected) {
      device.binding = 'disconnected';
      device.collection.status = 'disconnected';
    }

    await render(state);

    expect(host.querySelector('.operation-status')?.textContent?.trim() ?? null).toBe(text);
  });

  it('component device type override warns before apply and suggests a manual read', async () => {
    const onSetDeviceType = vi.fn().mockResolvedValue('accepted');

    await render(makeState(), {onSetDeviceType});

    const select = host.querySelector<HTMLElement>('mndw-select');

    select?.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: 'sntasmedia'},
      }),
    );
    await settled();
    flushSync();

    expect(host.textContent).toContain('A wrong bridge type can return false data');
    expect(host.textContent).toContain('1058:25a0');
    expect(onSetDeviceType).not.toHaveBeenCalled();

    host.querySelector<HTMLElement>('[data-testid="confirm-device-type"]')?.click();
    await settled();
    flushSync();

    expect(onSetDeviceType).toHaveBeenCalledExactlyOnceWith('dev-a', 'sntasmedia');
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Run a manual read to validate this device type');
    });
  });

  it('asks before reading and reads nothing when the dialog is declined', async () => {
    const onRefresh = vi.fn().mockResolvedValue('accepted');
    const confirmWake = vi.fn().mockResolvedValue(declined);

    await render(makeState(), {onRefresh, confirmWake});
    host.querySelector<HTMLElement>('[data-testid="refresh"]')?.click();
    await settled();

    expect(confirmWake).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('may wake it from standby');
  });

  it.each([true, false])('reads once with remember=%s when the dialog is confirmed', async (remember) => {
    const onRefresh = vi.fn().mockResolvedValue('accepted');

    await render(makeState(), {onRefresh, confirmWake: confirmedWith(remember)});
    host.querySelector<HTMLElement>('[data-testid="refresh"]')?.click();
    await settled();

    expect(onRefresh).toHaveBeenCalledExactlyOnceWith('dev-a', remember);
  });

  it('opens no second dialog while the first one is open', async () => {
    let answer: (decision: WakeDecision) => void = () => {};
    const confirmWake = vi.fn(() =>
      new Promise<WakeDecision>((resolve) => {
        answer = resolve;
      })
    );
    const onRefresh = vi.fn().mockResolvedValue('accepted');

    await render(makeState(), {onRefresh, confirmWake});

    const trigger = host.querySelector<HTMLElement>('[data-testid="refresh"]');

    trigger?.click();
    trigger?.click();
    await settled();
    expect(confirmWake).toHaveBeenCalledOnce();

    answer({confirmed: true, remember: false});
    await settled();
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith('dev-a', false);

    trigger?.click();
    await settled();
    expect(confirmWake).toHaveBeenCalledTimes(2);
  });

  describe('a dialog that is open while the page changes', () => {
    const asDisconnected = (state: PageState): PageState => {
      const next = structuredClone(state);
      const first = next.snapshot?.devices[0];

      if (first === undefined) { throw new Error('fixture device is missing'); }

      first.binding = 'disconnected';
      first.collection.status = 'disconnected';

      return next;
    };
    const withRunningRead = (state: PageState): PageState => ({...state,
      operation: {schemaVersion: 1, id: 'op-1', kind: 'refresh', deviceId: 'dev-a', status: 'running',
        createdAt: '2026-11-24T11:59:00Z', completedAt: null, result: null, error: null}});
    const scenarios: Array<[string, (state: PageState) => PageState]> = [
      ['another drive is selected', (state) => ({...state, selectedDeviceId: 'dev-b'})],
      ['the drive disconnects', asDisconnected],
      ['another operation starts running', withRunningRead],
      ['the backend becomes terminal', (state) => ({...state, backendAvailability: 'disabled'})],
    ];

    async function openDialog(onFocusLost?: () => void): Promise<{
      state: PageState;
      signals: AbortSignal[];
      answer: (decision: WakeDecision) => void;
      onRefresh: ReturnType<typeof vi.fn>;
    }> {
      const signals: AbortSignal[] = [];
      let answer: (decision: WakeDecision) => void = () => {};
      // The real dialog resolves as declined when it is aborted; the stub only records the signal and lets the test
      // answer later, so the guard after the answer is checked on its own.
      const confirmWake = vi.fn((_canRemember: boolean, signal: AbortSignal) => {
        signals.push(signal);

        return new Promise<WakeDecision>((resolve) => {
          answer = resolve;
        });
      });
      const onRefresh = vi.fn().mockResolvedValue('accepted');
      const state = makeTwoDeviceState();

      await renderSelectionHarness(state, onRefresh, undefined, confirmWake, onFocusLost);

      const trigger = host.querySelector<HTMLElement>('[data-testid="refresh"]');

      trigger?.focus();
      trigger?.click();
      await settled();

      return {state, signals, answer: (decision) => answer(decision), onRefresh};
    }

    const update = async (state: PageState): Promise<void> => {
      (app as unknown as {update: (next: PageState) => void}).update(state);
      await settled();
      flushSync();
    };

    it.each(scenarios)('closes the dialog and reads nothing when %s', async (_name, change) => {
      const dialog = await openDialog();

      expect(dialog.signals[0]?.aborted).toBe(false);
      await update(change(dialog.state));
      expect(dialog.signals[0]?.aborted).toBe(true);

      dialog.answer({confirmed: true, remember: true});
      await settled();
      expect(dialog.onRefresh).not.toHaveBeenCalled();
    });

    // Every poll publishes a new state object; only a changed selection, drive state or operation may close the dialog.
    it.each([
      [
        'a new snapshot with the same content',
        (state: PageState): PageState => ({...state, snapshot: structuredClone(state.snapshot)}),
      ],
      ['a notice-only change', (state: PageState): PageState => ({...state, notice: {kind: 'backend-recovered'}})],
    ])('keeps the dialog open for %s', async (_name, change) => {
      const dialog = await openDialog();

      await update(change(dialog.state));
      expect(dialog.signals[0]?.aborted).toBe(false);

      dialog.answer({confirmed: true, remember: false});
      await settled();
      expect(dialog.onRefresh).toHaveBeenCalledExactlyOnceWith('dev-a', false);
    });

    it('hands focus to the page when the details are hidden once the dialog closes', async () => {
      const onFocusLost = vi.fn();
      const dialog = await openDialog(onFocusLost);

      host.style.display = 'none';
      await update(asDisconnected(dialog.state));
      dialog.answer(declined);
      await settled();

      expect(onFocusLost).toHaveBeenCalledOnce();
      expect(document.activeElement).not.toBe(host.querySelector('#details-title'));
    });

    it('moves focus to the details heading when the dialog closes and the read button is gone', async () => {
      const dialog = await openDialog();

      await update(asDisconnected(dialog.state));
      dialog.answer(declined);
      await settled();
      flushSync();

      expect(document.activeElement).toBe(host.querySelector('#details-title'));
    });
  });

  it('reads at once, without a dialog, when the page says no confirmation is required', async () => {
    const onRefresh = vi.fn().mockResolvedValue('accepted');
    const confirmWake = vi.fn();

    await render(makeState({wakeConfirmationRequired: false}), {onRefresh, confirmWake});
    host.querySelector<HTMLElement>('[data-testid="refresh"]')?.click();
    await settled();

    expect(onRefresh).toHaveBeenCalledExactlyOnceWith('dev-a');
    expect(confirmWake).not.toHaveBeenCalled();
  });

  it.each([
    ['reliable identity', (device: NonNullable<Snapshot['devices'][number]>) => {
      if (device.sample === null) { throw new Error('fixture sample is missing'); }

      device.sample.identity = {...device.sample.identity, reliable: true, model: 'ACME', serial: 'SERIAL-1'};
    }, true],
    ['unreliable identity', (device: NonNullable<Snapshot['devices'][number]>) => {
      if (device.sample === null) { throw new Error('fixture sample is missing'); }

      device.sample.identity = {...device.sample.identity, reliable: false, model: 'ACME', serial: 'SERIAL-1'};
    }, false],
    ['missing serial', (device: NonNullable<Snapshot['devices'][number]>) => {
      if (device.sample === null) { throw new Error('fixture sample is missing'); }

      device.sample.identity = {...device.sample.identity, reliable: true, model: 'ACME', serial: null};
    }, false],
    ['absent sample', (device: NonNullable<Snapshot['devices'][number]>) => {
      device.sample = null;
    }, false],
  ])('offers remember consent only with %s', async (_name, update, expected) => {
    const state = makeState();
    const device = state.snapshot?.devices[0];

    if (device === undefined) { throw new Error('fixture device is missing'); }

    const confirmWake = vi.fn().mockResolvedValue(declined);

    update(device);
    await render(state, {confirmWake});
    host.querySelector<HTMLElement>('[data-testid="refresh"]')?.click();
    await settled();

    expect(confirmWake).toHaveBeenCalledExactlyOnceWith(expected, expect.any(AbortSignal));
  });

  it('formats the last successful read and keeps its raw time', async () => {
    await render(makeState());

    const raw = '2026-11-24T11:59:57Z';

    expect(host.textContent).toContain(formatted(raw));
    expect(host.querySelector(`time[datetime="${raw}"]`)?.getAttribute('title')).toBe(raw);
  });

  describe('assessment summary', () => {
    const summaryLines = (): string[] => {
      return [...host.querySelectorAll('.summary > p, .summary li')].map((line) => {
        return (line.textContent ?? '').replace(/\s+/g, ' ').trim();
      });
    };
    const withState = async (
      update: (device: NonNullable<Snapshot['devices'][number]>) => void,
    ): Promise<void> => {
      const state = makeState();
      const device = state.snapshot?.devices[0];

      if (device === undefined) { throw new Error('fixture device is missing'); }

      update(device);
      await render(state);
    };
    const fresh = (lastSuccessAt: string | null, stale = false): Freshness => ({lastAttemptAt: null, lastSuccessAt,
      stale});
    const status = (value: Collection['status'], exitCode: number | null = null): Collection => ({status: value,
      exitCode});
    const raw = '2026-11-24T11:59:57Z';

    it('shows a drive without health data in three lines', async () => {
      await withState((device) => {
        if (device.sample === null) { throw new Error('fixture sample is missing'); }

        device.sample.health = 'unknown';
        device.sample.assessment = {level: 'unknown', reasons: ['no-health-data'], rulesVersion: 1};
        device.collection = status('ok', 0);
        device.freshness = fresh(raw);
      });

      expect(host.querySelector('.summary')?.querySelector('h3')?.textContent).toBe('Health assessment');
      expect(summaryLines()).toEqual([
        'Unknown health · No health data is available for assessment.',
        `Read succeeded: ${formatted(raw)}`,
      ]);
      expect(host.querySelector('.summary ul')).toBeNull();
      expect(host.textContent).not.toContain('Assessment unavailable');
      expect(host.textContent).not.toContain('Latest data is current');
    });

    it('keeps a bulleted list for several reasons and names a known level', async () => {
      await withState((device) => {
        if (device.sample === null) { throw new Error('fixture sample is missing'); }

        device.sample.health = 'failed';
        device.sample.assessment = {
          level: 'critical',
          reasons: ['smart-health-failed', 'ata-pending-sectors'],
          rulesVersion: 1,
        };
      });

      expect(summaryLines().slice(0, 3)).toEqual([
        'Failed · Critical',
        'The device reports a failed S.M.A.R.T. health check.',
        'The device reports pending sectors.',
      ]);
      expect(host.querySelectorAll('.summary li')).toHaveLength(2);
    });

    it('shows a drive without a sample as one muted health line', async () => {
      await withState((device) => {
        device.sample = null;
        device.collection = status('never-read');
        device.freshness = fresh(null);
      });

      expect(summaryLines()).toEqual(['No health data', 'Not read yet']);
    });

    it.each(
      [
        ['a stale read stays on one line', status('ok', 0), fresh(raw, true), [
          `Read succeeded: ${formatted(raw)} · Data is older than 60 minutes`,
        ]],
        ['a read with a smartctl code', status('ok', 2), fresh(raw), [
          `Read succeeded (smartctl exit code 2): ${formatted(raw)}`,
        ]],
        ['a failed read after a success', status('timeout'), fresh(raw, true), [
          'Latest read: Read timed out',
          `Last successful read: ${formatted(raw)} · Data is older than 60 minutes`,
        ]],
        ['a failed read with no success yet', status('command-failed', 1), fresh(null), [
          'Latest read: Read command failed (smartctl exit code: 1)',
          'No successful read yet',
        ]],
      ] as const,
    )('describes the read for %s', async (_name, collection, freshness, expected) => {
      await withState((device) => {
        device.collection = {...collection};
        device.freshness = {...freshness};
      });

      expect(summaryLines().slice(-expected.length)).toEqual(expected);
    });
  });

  it.each([
    [0, 'Read succeeded'],
    [4, 'Read partially: some commands to the disk failed (smartctl exit code 4)'],
    [2, 'Read succeeded (smartctl exit code 2)'],
  ])('renders smartctl exit code %s as a readable latest-read line', async (exitCode, expected) => {
    const state = makeState();

    if (state.snapshot?.devices[0] === undefined) { throw new Error('fixture device is missing'); }

    state.snapshot.devices[0].collection = {status: 'ok', exitCode};
    await render(state);

    expect(host.querySelector('.collection-line')?.textContent).toContain(expected);
  });

  it('device type cancel clears the draft and restores focus to the select', async () => {
    await render(makeState());

    const select = host.querySelector<HTMLElement>('mndw-select');

    changeSelectValue(select, 'sntasmedia');
    await settled();
    flushSync();
    select?.focus();
    host.querySelector<HTMLElement>('[data-testid="cancel-device-type"]')?.click();
    await settled();
    flushSync();

    expect(host.querySelector('[data-testid="confirm-device-type"]')).toBeNull();
    expect((select as (HTMLElement & {value?: string}) | null)?.value).toBe('auto');
    expect(document.activeElement).toBe(select);
    expect(host.textContent).not.toContain('Run a manual read to validate this device type');
  });

  it('auto type override confirms as null', async () => {
    const state = makeState();
    const device = state.snapshot?.devices[0];

    if (device === undefined) { throw new Error('fixture device is missing'); }

    device.deviceType = 'sat';
    device.deviceTypeSource = 'user';

    const onSetDeviceType = vi.fn().mockResolvedValue('accepted');

    await render(state, {onSetDeviceType});
    changeSelectValue(host.querySelector<HTMLElement>('mndw-select'), 'auto');
    await settled();
    flushSync();
    host.querySelector<HTMLElement>('[data-testid="confirm-device-type"]')?.click();
    await settled();

    expect(onSetDeviceType).toHaveBeenCalledExactlyOnceWith('dev-a', null);
  });

  it('rejected type override keeps confirmation and does not show success hint', async () => {
    await render(makeState(), {onSetDeviceType: vi.fn().mockResolvedValue('rejected')});
    changeSelectValue(host.querySelector<HTMLElement>('mndw-select'), 'sntasmedia');
    await settled();
    flushSync();
    host.querySelector<HTMLElement>('[data-testid="confirm-device-type"]')?.click();
    await settled();
    flushSync();

    expect(host.querySelector('[data-testid="confirm-device-type"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Run a manual read to validate this device type');
  });

  it.each(['accepted', 'rejected'] as const)('restores focus to the type select after Apply is %s', async (result) => {
    const onSetDeviceType = vi.fn().mockResolvedValue(result);

    await render(makeState(), {onSetDeviceType});

    const select = host.querySelector<HTMLElement>('mndw-select');

    changeSelectValue(select, 'sntasmedia');
    await settled();
    flushSync();

    const confirm = host.querySelector<HTMLElement>('[data-testid="confirm-device-type"]');

    confirm?.focus();
    confirm?.click();
    await settled();
    flushSync();

    expect(onSetDeviceType).toHaveBeenCalledExactlyOnceWith('dev-a', 'sntasmedia');
    await vi.waitFor(() => expect(document.activeElement).toBe(select));
    expect(document.activeElement).toBe(select);
  });

  it('hides type confirmation when proposed value equals current value', async () => {
    const state = makeState();
    const device = state.snapshot?.devices[0];

    if (device === undefined) { throw new Error('fixture device is missing'); }

    device.deviceType = 'sat';
    device.deviceTypeSource = 'user';

    await render(state);
    changeSelectValue(host.querySelector<HTMLElement>('mndw-select'), 'sat');
    await settled();
    flushSync();

    expect(host.querySelector('[data-testid="confirm-device-type"]')).toBeNull();
  });

  it('clears pending device actions on direct A to B selection change', async () => {
    const onRefresh = vi.fn().mockResolvedValue('accepted');

    await renderSelectionHarness(makeTwoDeviceState(), onRefresh);
    changeSelectValue(host.querySelector<HTMLElement>('mndw-select'), 'sntasmedia');
    await settled();
    flushSync();
    expect(host.textContent).toContain('A wrong bridge type can return false data');

    host.querySelector<HTMLElement>('[data-testid="select-dev-b"]')?.click();
    await settled();
    flushSync();

    expect(host.textContent).toContain('Second device');
    expect(host.textContent).not.toContain('A wrong bridge type can return false data');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('clears pending device actions on A to no selection to B', async () => {
    await renderSelectionHarness(makeTwoDeviceState());
    changeSelectValue(host.querySelector<HTMLElement>('mndw-select'), 'sntasmedia');
    await settled();
    flushSync();
    expect(host.textContent).toContain('A wrong bridge type can return false data');

    host.querySelector<HTMLElement>('[data-testid="select-none"]')?.click();
    await settled();
    flushSync();
    expect(host.querySelector('mndw-select')).toBeNull();
    host.querySelector<HTMLElement>('[data-testid="select-dev-b"]')?.click();
    await settled();
    flushSync();

    expect(host.textContent).toContain('Second device');
    expect(host.textContent).not.toContain('A wrong bridge type can return false data');
  });

  it('does not show type-change success after selection changes while request is pending', async () => {
    let finishAction: ((result: ActionResult) => void) | undefined;
    const action = new Promise<ActionResult>((resolve) => {
      finishAction = resolve;
    });
    const onSetDeviceType = vi.fn(() => action);
    const state = makeTwoDeviceState();
    const snapshot = state.snapshot;

    if (snapshot?.devices[0] === undefined) { throw new Error('fixture device is missing'); }

    snapshot.devices[0].deviceTypeSource = 'user';
    snapshot.devices[0].deviceType = 'sat';
    await renderSelectionHarness(state, undefined, onSetDeviceType);
    changeSelectValue(host.querySelector<HTMLElement>('mndw-select'), 'sntasmedia');
    await settled();
    flushSync();
    host.querySelector<HTMLElement>('[data-testid="confirm-device-type"]')?.click();
    await settled();
    flushSync();
    expect(onSetDeviceType).toHaveBeenCalledExactlyOnceWith('dev-a', 'sntasmedia');
    host.querySelector<HTMLElement>('[data-testid="select-dev-b"]')?.click();
    await settled();
    finishAction?.('accepted');
    await action;
    await settled();
    flushSync();

    expect(host.textContent).toContain('Second device');
    expect(host.textContent).not.toContain('Run a manual read to validate this device type');
  });

  it('renders model and nullable attributes as text', async () => {
    const state = makeState();

    if (state.snapshot?.devices[0]?.sample === null || state.snapshot?.devices[0]?.sample === undefined) {
      throw new Error('fixture sample is missing');
    }

    state.snapshot.devices[0].sample.identity.model = '<img src=x onerror=alert(1)>';

    const attribute = state.snapshot.devices[0].sample.attributes[0];

    if (attribute === undefined) {
      throw new Error('fixture attribute is missing');
    }

    state.snapshot.devices[0].sample.attributes[0] = {
      ...attribute,
      raw: null,
      normalized: null,
      threshold: null,
    };
    await render(state);

    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('[data-testid="attribute-raw"]')?.textContent).toBe('—');
    expect(host.querySelector('[data-testid="attribute-normalized"]')?.textContent).toBe('—');
    expect(host.querySelector('[data-testid="attribute-threshold"]')?.textContent).toBe('—');
    expect(host.textContent).not.toContain('ACME HDD 2TB</dd>\n    Serial');
  });

  describe('identity rows', () => {
    const rows = (): Map<string, string> => {
      const terms = [...host.querySelectorAll('.identity dt')];

      return new Map(terms.map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? '']));
    };

    it('names the drive model, shows no WWN and writes the capacity with its exact byte count', async () => {
      await render(makeState());

      expect(rows().get('Drive model')).toBe('ACME HDD 2TB');
      expect(rows().get('Capacity')).toBe('2 TB (2,000,398,934,016 bytes)');
      expect(rows().has('World Wide Name')).toBe(false);
      expect(host.textContent).not.toContain('0x5001b448b9a1c001');
    });

    it('writes the capacity in Russian with grouped digits', async () => {
      await render(makeState(), {locale: 'ru'});

      expect(
        rows().get('Ёмкость')
          ?.replaceAll(/\s/g, ' '),
      ).toBe('2 ТБ (2 000 398 934 016 байт)');
    });

    it.each([
      [
        'both parts',
        {manufacturer: 'Western Digital', product: 'My Passport 25A0'},
        'Western Digital My Passport 25A0',
      ],
      ['only the product', {product: 'My Passport 25A0'}, 'My Passport 25A0'],
      ['only the manufacturer', {manufacturer: 'Western Digital'}, 'Western Digital'],
    ])('shows one USB device row with %s', async (_name, usb, expected) => {
      await render(makeState(), {usb});

      expect(rows().get('USB device')).toBe(expected);
      expect(rows().has('Manufacturer')).toBe(false);
      expect(rows().has('Product')).toBe(false);
    });

    it('omits the USB device row when the router names neither part', async () => {
      await render(makeState(), {usb: {port: '1'}});

      expect(rows().has('USB device')).toBe(false);
      expect(rows().get('USB port')).toBe('1');
    });
  });

  it.each(
    [
      ['a known type by the option list label', 'sntasmedia', 'ru', 'Текущий тип: NVMe через USB ASMedia'],
      ['a known type in English', 'scsi', 'en', 'Current type: SCSI'],
      ['an unknown type as it is', 'sat,12', 'en', 'Current type: sat,12'],
    ] as const,
  )('shows the current device type as %s', async (_name, deviceType, locale, expected) => {
    const state = makeState();

    if (state.snapshot?.devices[0] === undefined) { throw new Error('fixture device is missing'); }

    state.snapshot.devices[0].deviceType = deviceType;
    await render(state, {locale});

    expect(host.querySelector('.device-type p')?.textContent).toBe(expected);
  });

  it('omits temperature when there is no sample', async () => {
    const state = makeState();

    if (state.snapshot?.devices[0] === undefined) { throw new Error('fixture device is missing'); }

    state.snapshot.devices[0].sample = null;
    await render(state);

    expect(host.textContent).not.toContain('Temperature');
    expect(host.textContent).not.toContain('— °C');

    const serialTerm = [...host.querySelectorAll('dt')].find((term) => term.textContent === 'Serial number');

    expect(serialTerm?.nextElementSibling?.textContent).toBe('—');
  });
});
