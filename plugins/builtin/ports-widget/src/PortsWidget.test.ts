import {flushSync, mount, unmount} from 'svelte';
import {afterEach, expect, it, vi} from 'vitest';
import {computeTooltipCoords} from '@mndw/ui';
import type {DeviceInfo, OverlayOpenOptions, OverlaySession, PluginInstance, RciQuery, Switchports} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import messages from '../i18n/en.json';
import ruMessages from '../i18n/ru.json';
import manifest from '../manifest.json';
import countersReply from './fixtures/counters.json';
import switchportsFixture from './fixtures/switchports.json';
import upReply from './fixtures/interface-up-100.json';
import portColumnSource from './components/PortColumn.svelte?raw';
import portsWidgetSource from './PortsWidget.svelte?raw';
import PortsWidget from './PortsWidget.svelte';
import {createInstance} from './index.js';

type RciReply = Record<string, unknown>;

interface RciState {
  links: Record<string, RciReply>;
  counters: Record<string, RciReply>;
  capabilities: Record<string, RciReply>;
  rcInterfaces: Record<string, RciReply>;
  hotspot: RciReply;
  fail: boolean;
}

const capabilities = (speed: number): RciReply => ({mdi: {phy: [{speed, duplex: 'full'}]}});

function inventory(overrides: Partial<Switchports> = {}): Switchports {
  return {...(switchportsFixture as unknown as Switchports), ...overrides};
}

function deviceInfo(switchports: Switchports): DeviceInfo {
  return {
    deviceName: '',
    vendor: '',
    manufacturer: '',
    model: '',
    series: '',
    region: '',
    hwId: '',
    hwVersion: '',
    firmwareVersion: '',
    firmwareRelease: '',
    features: [],
    components: [],
    switchports,
    usb: {ports: []},
    hasFeature: () => false,
    hasComponent: () => false,
  };
}

function counterSnapshot(timestamp: number, rxBytes: number, txBytes: number): RciReply {
  return {
    timestamp: String(timestamp),
    rxbytes: String(rxBytes),
    txbytes: String(txBytes),
    rxpackets: '1000',
    txpackets: '1000',
    rxerrors: '0',
    txerrors: '0',
    rxdropped: '0',
    txdropped: '0',
  };
}

function defaultState(switchports: Switchports): RciState {
  const links: Record<string, RciReply> = {};
  const counterMap: Record<string, RciReply> = {};
  const capabilityMap: Record<string, RciReply> = {};

  for (const port of switchports.list) {
    links[port.interfaceId] = {id: port.interfaceId, link: 'down'};
    counterMap[port.interfaceId] = counterSnapshot(8380, 1_000_000, 500_000);
    capabilityMap[port.interfaceId] = capabilities(port.id === 'LAN5' ? 10000 : 1000);
  }

  links['GigabitEthernet1/0'] = {
    'id': 'GigabitEthernet1/0',
    'link': 'up',
    'speed': '1000',
    'duplex': 'full',
    'auto-negotiation': 'on',
    'flow-control': 'off',
    'eee': 'off',
    'last-change': '8300.000000',
  };
  links['GigabitEthernet0/3'] = upReply;
  counterMap['GigabitEthernet0/3'] = countersReply;

  return {
    links,
    counters: counterMap,
    capabilities: capabilityMap,
    rcInterfaces: {},
    hotspot: {host: []},
    fail: false,
  };
}

function replyFor(query: RciQuery, state: RciState): unknown {
  const name = typeof query.data?.name === 'string' ? query.data.name : '';

  switch (query.path) {
    case 'show.interface':
      return state.links[name] ?? {};
    case 'show.interface.stat':
      return state.counters[name] ?? {};
    case 'show.interface.ethernet.capabilities':
      return state.capabilities[name] ?? {};
    case 'show.rc.interface':
      return state.rcInterfaces;
    case 'show.ip.hotspot':
      return state.hotspot;
    case 'interface': {
      const description = query.data?.description;

      if (description !== null && typeof description === 'object' && 'no' in description) {
        delete state.rcInterfaces[name];
      } else if (typeof description === 'string') {
        state.rcInterfaces[name] = {description};
      }

      return {};
    }
    default:
      return {};
  }
}

interface SubscriberLike<T> {
  next(value: T): void;
  error(error: unknown): void;
  complete(): void;
}

/** A one-shot source with the `subscribe` surface `firstValueFrom` needs, without a direct rxjs dependency. */
function observableOf<T>(value: T): never {
  return {
    subscribe(subscriber: SubscriberLike<T>) {
      subscriber.next(value);
      subscriber.complete();

      return {unsubscribe: (): void => undefined};
    },
  } as never;
}

function failingObservable(): never {
  return {
    subscribe(subscriber: SubscriberLike<never>) {
      subscriber.error(new Error('rci unavailable'));

      return {unsubscribe: (): void => undefined};
    },
  } as never;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }

  flushSync();
  await Promise.resolve();
  flushSync();
}

interface HarnessOptions {
  readonly switchports?: Switchports;
  readonly state?: RciState;
  readonly storedSettings?: unknown;
  readonly useInstance?: boolean;
}

interface OpenedOverlay {
  readonly target: HTMLDivElement;
  readonly title: string;
  readonly closed: boolean;
  close(): void;
}

async function createHarness(options: HarnessOptions = {}) {
  const switchports = options.switchports ?? inventory();
  const state = options.state ?? defaultState(switchports);
  const batches: RciQuery[][] = [];
  const queue = vi.fn((request: RciQuery | RciQuery[]) => {
    const list = Array.isArray(request) ? request : [request];

    batches.push(list);

    if (state.fail) {
      return failingObservable();
    }

    return observableOf(list.map((query) => replyFor(query, state)));
  });
  const i18n = createTestI18n(messages);
  const fixture = createTestPluginContext({
    i18n,
    device: {info: deviceInfo(switchports), rci: {queue: queue as never}},
  });
  const openedOverlays: OpenedOverlay[] = [];
  const openOverlay = (overlayOptions: OverlayOpenOptions<unknown>): OverlaySession<unknown> => {
    const target = document.createElement('div');
    let cleanup: () => void | Promise<void> = () => undefined;
    let closed = false;
    const controller = new AbortController();
    const session = {
      hostElement: target,
      contentElement: target,
      isOpen: true,
      state: 'open',
      closed: Promise.resolve({reason: 'api' as const}),
      signal: controller.signal,
      close: () => {
        if (!closed) {
          closed = true;
          void cleanup();
          target.remove();
        }
      },
      setCleanup: (next: (() => void | Promise<void>) | Promise<() => void | Promise<void>>) => {
        if (typeof next === 'function') {
          cleanup = next;
        } else {
          void next.then((resolved) => {
            cleanup = resolved;
          });
        }
      },
      markReady: () => undefined,
      update: () => undefined,
      onClose: () => (): void => undefined,
    };
    const overlay: OpenedOverlay = {
      target,
      title: overlayOptions.title ?? '',
      get closed(): boolean {
        return closed;
      },
      close: () => session.close(),
    };

    document.body.append(target);
    openedOverlays.push(overlay);
    overlayOptions.mount(target, session, controller.signal);

    return session;
  };

  Object.defineProperty(fixture.context.overlay, 'open', {value: vi.fn(openOverlay)});

  const target = document.createElement('div');

  document.body.append(target);

  if (options.storedSettings !== undefined) {
    await fixture.context.storage.instance.set('line-settings', JSON.stringify(options.storedSettings));
  }

  const app: ReturnType<typeof mount> | undefined = options.useInstance === true
    ? undefined
    : mount(PortsWidget, {target, props: {context: fixture.context}});
  const instance: PluginInstance | undefined = options.useInstance === true
    ? createInstance(target, fixture.context)
    : undefined;

  await flush();

  return {
    app,
    batches,
    openedOverlays,
    close: async (): Promise<void> => {
      if (instance !== undefined) {
        await instance.unmount();
      } else if (app !== undefined) {
        await unmount(app);
      }

      openedOverlays.forEach((overlay) => overlay.close());

      fixture.unmount();
      target.remove();
    },
    fixture,
    i18n,
    state,
    target,
  };
}

it('defaults to four grid rows', () => {
  expect(manifest.size).toEqual({w: 4, h: 4, minW: 3, minH: 2});
});

afterEach(() => {
  document.body.innerHTML = '';
});

it('draws the ports in their physical rows and order', async () => {
  const switchports = inventory({
    layout: [['0'], ['1', '2', '3', '4']],
    list: (switchportsFixture as unknown as Switchports).list.slice(0, 5),
  });
  const harness = await createHarness({switchports});

  try {
    expect(
      [...harness.target.querySelectorAll<HTMLElement>('[data-row]')].map((row) =>
        [...row.querySelectorAll<HTMLElement>('[data-port-id]')].map((item) => item.dataset.portId)
      ),
    )
      .toEqual([
        ['WAN'],
        ['LAN1', 'LAN2', 'LAN3', 'LAN4'],
      ]);
    expect(harness.target.querySelector('.label')).toBeNull();
  } finally {
    await harness.close();
  }
});

it('shows down, slow and full-speed links in the view and the accessible name', async () => {
  const harness = await createHarness();
  const trigger = (id: string): HTMLElement => {
    const element = harness.target.querySelector<HTMLElement>(`[data-port-id="${id}"]`);

    if (element === null) {
      throw new Error(`port ${id} not rendered`);
    }

    return element;
  };

  try {
    const down = trigger('LAN1').querySelector<HTMLElement>('.port-trigger');

    expect(down?.getAttribute('aria-label')).toBe('Port 1, LAN: link down');
    expect(down?.classList.contains('down')).toBe(true);

    const downSpeed = harness.target.querySelector<HTMLElement>('[data-port-id="LAN1"] .speed');
    const downDuplex = harness.target.querySelector<HTMLElement>('[data-port-id="LAN1"] .duplex');

    expect(downSpeed?.textContent?.trim()).toBe('—');
    expect(downDuplex?.textContent?.trim()).toBe('—');
    expect(downSpeed?.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
    expect(portColumnSource).toMatch(/\.missing-value\s*\{[^}]*color:\s*var\(--mndw-text-muted\)/su);

    const slow = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"] .port-trigger');

    expect(slow?.getAttribute('aria-label')).toBe(
      'Port 4, LAN: link up, 100 Mbps full duplex, slower than the 1 Gbps maximum',
    );
    expect(harness.target.querySelector('[data-port-id="LAN4"] .speed')?.textContent).toContain('100 M');
    expect(harness.target.querySelector('[data-port-id="LAN4"] .speed')?.classList.contains('warning')).toBe(true);
    expect(harness.target.querySelector('[data-port-id="LAN4"] .speed mndw-icon')).not.toBeNull();

    const full = harness.target.querySelector<HTMLElement>('[data-port-id="WAN"] .port-trigger');

    expect(full?.getAttribute('aria-label')).toBe('Port 0, WAN: link up, 1 Gbps full duplex');
    expect(harness.target.querySelector('[data-port-id="WAN"] .speed')?.textContent).toContain('1.0 G');
    expect(harness.target.querySelector('[data-port-id="WAN"] .speed mndw-icon')).toBeNull();
  } finally {
    await harness.close();
  }
});

it('shows a dash when an up link has unknown speed or duplex', async () => {
  const state = defaultState(inventory());

  state.links['GigabitEthernet0/1'] = {link: 'up', duplex: 'full'};
  state.links['GigabitEthernet0/2'] = {link: 'up', speed: '1000'};

  const harness = await createHarness({
    state,
    storedSettings: {rows: ['speed', 'duplex']},
  });

  try {
    const missingSpeed = harness.target.querySelector<HTMLElement>('[data-port-id="LAN2"]');
    const missingDuplex = harness.target.querySelector<HTMLElement>('[data-port-id="LAN3"]');

    expect(missingSpeed?.querySelector('.speed')?.textContent?.trim()).toBe('—');
    expect(missingSpeed?.querySelector('.duplex')?.textContent?.trim()).toBe('FDX');
    expect(missingDuplex?.querySelector('.speed')?.textContent).toContain('1.0 G');
    expect(missingDuplex?.querySelector('.duplex')?.textContent?.trim()).toBe('—');
    expect(missingSpeed?.querySelector('.speed [aria-hidden="true"]')?.textContent).toBe('—');
    expect(missingDuplex?.querySelector('.duplex [aria-hidden="true"]')?.textContent).toBe('—');
  } finally {
    await harness.close();
  }
});

it('maps the router link and switchport metadata onto mndw-switchport', async () => {
  const harness = await createHarness();

  harness.state.links['GigabitEthernet0/3'] = {
    ...harness.state.links['GigabitEthernet0/3'],
    active: 'sfp',
    role: ['inet'],
  };
  harness.fixture.tick();
  await flush();

  try {
    const switchport = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"] mndw-switchport');

    expect(switchport?.getAttribute('type')).toBe('ethernet');
    expect(switchport?.getAttribute('color')).toBe('gray');
    expect(switchport?.getAttribute('label')).toBe('4');
    expect(switchport?.hasAttribute('reversed')).toBe(true);
    expect(switchport?.getAttribute('active')).toBe('sfp');
    expect(switchport?.hasAttribute('link')).toBe(true);
    expect(switchport?.getAttribute('port-role')).toBe('inet');
  } finally {
    await harness.close();
  }
});

it('opens the linked port tooltip with statistics, description, and active devices', async () => {
  const state = defaultState(inventory());

  state.rcInterfaces['GigabitEthernet0/3'] = {description: 'Office uplink'};
  state.hotspot = {
    host: [
      {active: true, port: '4', name: 'Work laptop'},
      {active: true, mws: {port: '4'}, hostname: 'Mesh client'},
      {active: false, port: '4', name: 'Offline client'},
    ],
  };

  const harness = await createHarness({state});

  try {
    const port = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"]');
    const trigger = port?.querySelector<HTMLElement>('.port-trigger');

    trigger?.focus();
    await flush();

    const tooltip = port?.querySelector<HTMLElement>('.tooltip');

    expect(port?.querySelector('.description-text')?.textContent).toBe('Office uplink');
    expect(tooltip?.textContent).toContain('RX 1.8 GB');
    expect(tooltip?.textContent).toContain('TX 988 MB');
    expect(tooltip?.textContent).toContain('Office uplink');
    expect(tooltip?.textContent).toContain('Work laptop');
    expect(tooltip?.textContent).toContain('Mesh client');
    expect(tooltip?.textContent).not.toContain('Offline client');
    expect(tooltip?.textContent).toContain('Link changed 2 hours ago');
    expect(tooltip?.textContent).toContain('Maximum 1 Gbps');
    expect(portColumnSource).toMatch(
      /\.tooltip\s*\{[^}]*padding:\s*var\(--mndw-space-1\)\s+var\(--mndw-space-2\)[^}]*font-size:\s*var\(--mndw-text-xs\)[^}]*line-height:\s*var\(--mndw-leading\)/su,
    );
    expect(portColumnSource).toMatch(/\.tooltip\s*\{[^}]*max-width:\s*min\(18rem,/su);
    expect(portColumnSource).toMatch(/\.tooltip\s*\{[^}]*overflow-wrap:\s*anywhere/su);
    expect(portColumnSource).toMatch(
      /\.tooltip-name,\s*\.tooltip-heading\s*\{[^}]*font-weight:\s*var\(--mndw-weight-semibold\)/su,
    );
    expect(portColumnSource).toMatch(/\.tooltip-heading\s*\{[^}]*margin-top:\s*var\(--mndw-space-2\)/su);

    const descriptionRow = port?.querySelector('.description');

    expect(descriptionRow).not.toBeNull();

    if (tooltip !== null && tooltip !== undefined && descriptionRow !== null) {
      expect(tooltip.compareDocumentPosition(descriptionRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  } finally {
    await harness.close();
  }
});

it('shows editable descriptions with intrinsic default columns', async () => {
  const harness = await createHarness();

  try {
    const description = harness.target.querySelector<HTMLButtonElement>(
      '[data-port-id="LAN4"] .description',
    );

    expect(description).not.toBeNull();

    if (description === null) {
      return;
    }

    expect(description.title).toBe('Rename port 4');
    expect(description.getAttribute('aria-label')).toBe('Rename port 4: unnamed');
    expect(description.hasAttribute('aria-describedby')).toBe(false);
    expect(description.querySelector('.description-placeholder')?.textContent).toBe('Name');
    expect(portColumnSource).toMatch(
      /:global\(:where\(\.rows-scroll:hover \.description, \.rows-scroll:has\(\.description:focus\) \.description\)\)/u,
    );
    expect(portColumnSource).toMatch(
      /outline:\s*1px dashed var\(--mndw-border\)[^}]*border-radius:\s*var\(--mndw-radius-sm\)/su,
    );
    expect(portColumnSource).toMatch(
      /\.description:hover\s*,\s*\.description:focus\s*\{[^}]*background:\s*var\(--mndw-control-hover\)[^}]*outline:\s*1px solid var\(--mndw-accent\)/su,
    );
    expect(portColumnSource).toMatch(
      /\.description:focus-visible\s*\{[^}]*outline:\s*var\(--mndw-focus-w\) solid var\(--mndw-focus-ring\)/su,
    );
    expect(portColumnSource).toMatch(
      /\.description-placeholder\s*\{[^}]*position:\s*absolute[^}]*top:\s*50%[^}]*left:\s*50%[^}]*right:\s*auto[^}]*color:\s*var\(--mndw-text-muted\)[^}]*visibility:\s*hidden[^}]*transform:\s*translate\(-50%,\s*-50%\)/su,
    );
    expect(harness.target.querySelector('.port-grid')?.getAttribute('style')).not.toMatch(/width/u);
    expect(portsWidgetSource).toMatch(
      /\.port-grid\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--columns\),\s*1fr\)[^}]*gap:\s*var\(--mndw-space-3\)[^}]*width:\s*max-content/su,
    );
    expect(portsWidgetSource).not.toMatch(/\.port-grid\s*\{[^}]*min-width:\s*100%/su);
    expect(portColumnSource).toMatch(/\.port-column\s*\{[^}]*padding:\s*2px/su);
    expect(portColumnSource).not.toMatch(/\.port-column\s*\{[^}]*min-width:/su);
    expect(portColumnSource).toMatch(
      /\.description:hover \.description-placeholder,\s*\.description:focus \.description-placeholder\s*\{[^}]*visibility:\s*visible/su,
    );
    expect(portColumnSource).toMatch(
      /@media\s*\(hover:\s*none\)[^{]*\{[\s\S]*?\.description\s*\{[^}]*outline:[^}]*dashed/su,
    );
    expect(portColumnSource).toMatch(
      /@media\s*\(hover:\s*none\)[^{]*\{[\s\S]*?\.description mndw-icon\s*\{[^}]*opacity:\s*1/su,
    );

    harness.i18n.setLocale('ru', ruMessages);
    await flush();

    expect(description.title).toBe('Переименовать порт 4');
    expect(description.querySelector('.description-placeholder')?.textContent).toBe('Имя');
  } finally {
    await harness.close();
  }
});

it('wraps and clamps long descriptions without changing equal column sizing', async () => {
  const state = defaultState(inventory());
  const longName = '11111231312 Living room media server';

  state.rcInterfaces['GigabitEthernet0/3'] = {description: longName};

  const harness = await createHarness({state, storedSettings: {rows: ['description']}});

  try {
    const port = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"]');
    const description = port?.querySelector<HTMLButtonElement>('.description');

    expect(description?.querySelector('.description-text')?.textContent).toBe(longName);
    expect(description?.title).toBe(`${longName} — Rename port 4`);
    expect(portColumnSource).toMatch(
      /\.description\s*\{[^}]*contain:\s*inline-size/su,
    );
    expect(portColumnSource).toMatch(
      /\.description-text\s*\{[^}]*width:\s*100%[^}]*overflow:\s*hidden[^}]*overflow-wrap:\s*anywhere[^}]*display:\s*-webkit-box[^}]*-webkit-line-clamp:\s*2[^}]*-webkit-box-orient:\s*vertical/su,
    );
    expect(portsWidgetSource).toMatch(
      /\.port-grid\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--columns\),\s*1fr\)[^}]*gap:\s*var\(--mndw-space-3\)[^}]*width:\s*max-content/su,
    );
    expect(portsWidgetSource).not.toMatch(/\.port-grid\s*\{[^}]*min-width:\s*100%/su);
    expect(portColumnSource).toMatch(/\.port-column\s*\{[^}]*padding:\s*2px/su);
    expect(portColumnSource).not.toMatch(/\.port-column\s*\{[^}]*min-width:/su);
    expect(portsWidgetSource).toMatch(
      /\.physical-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*subgrid[^}]*grid-template-rows:\s*repeat\(var\(--cell-rows\),\s*auto\)/su,
    );
    expect(portColumnSource).toMatch(
      /\.port-column\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*subgrid/su,
    );

    port?.querySelector<HTMLElement>('.port-trigger')?.focus();
    await flush();

    expect(port?.querySelector('.tooltip')?.textContent).toContain(longName);
  } finally {
    await harness.close();
  }
});

it('reserves two description lines for empty, short, and long names', async () => {
  const state = defaultState(inventory());
  const longName = 'Living room media server';

  state.rcInterfaces['GigabitEthernet0/3'] = {description: 'Office'};
  state.rcInterfaces['GigabitEthernet0/2'] = {description: longName};

  const harness = await createHarness({state, storedSettings: {rows: ['description']}});

  try {
    const empty = harness.target.querySelector<HTMLElement>('[data-port-id="LAN1"] .description');
    const short = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"] .description');
    const long = harness.target.querySelector<HTMLElement>('[data-port-id="LAN3"] .description');

    expect(empty?.querySelector('.description-placeholder')?.textContent).toBe('Name');
    expect(short?.querySelector('.description-text')?.textContent).toBe('Office');
    expect(long?.querySelector('.description-text')?.textContent).toBe(longName);
    expect(portColumnSource).toMatch(
      /\.cell\s*\{[^}]*align-items:\s*center[^}]*line-height:\s*1\.2/su,
    );
    expect(portColumnSource).toMatch(
      /\.description\s*\{[^}]*height:\s*calc\(2\.4em \+ 4px\)/su,
    );
    expect(portColumnSource).toMatch(
      /\.description-text\s*\{[^}]*-webkit-line-clamp:\s*2/su,
    );
  } finally {
    await harness.close();
  }
});

it('keeps the widget header fixed at settings-button height', async () => {
  const harness = await createHarness();

  try {
    expect(harness.target.querySelector('.widget-header')).not.toBeNull();
    expect(portsWidgetSource).toMatch(
      /\.widget-header\s*\{[^}]*height:\s*1\.75rem[^}]*flex:\s*none/su,
    );
    expect(portsWidgetSource).toMatch(
      /\.settings-button\s*\{[^}]*height:\s*1\.75rem/su,
    );
  } finally {
    await harness.close();
  }
});

it('keeps shared row gaps and insets the pencil inside the description slot', async () => {
  const harness = await createHarness();

  try {
    const description = harness.target.querySelector<HTMLButtonElement>(
      '[data-port-id="LAN4"] .description',
    );
    const speed = harness.target.querySelector<HTMLElement>(
      '[data-port-id="LAN4"] .cell.speed',
    );

    expect(description).not.toBeNull();
    expect(speed).not.toBeNull();

    if (description === null || speed === null) {
      return;
    }

    expect(portColumnSource).toMatch(/\.cell\s*\{[^}]*width:\s*100%[^}]*justify-content:\s*center/su);
    expect(portColumnSource).toMatch(/\.description\s*\{[^}]*contain:\s*inline-size[^}]*text-align:\s*center/su);
    expect(portColumnSource).toMatch(
      /\.port-column\s*\{[^}]*grid-template-rows:\s*subgrid[^}]*row-gap:\s*var\(--mndw-space-1\)/su,
    );
    expect(portColumnSource).toMatch(
      /\.port-anchor\s*\{[^}]*margin-bottom:\s*var\(--mndw-space-1\)/su,
    );
    expect(portColumnSource).toMatch(/\.description\s*\{[^}]*box-sizing:\s*border-box[^}]*padding:\s*2px/su);
    expect(portColumnSource).not.toMatch(/\.description\s*\{[^}]*padding-inline/su);
    expect(portColumnSource).toMatch(
      /\.description mndw-icon\s*\{[^}]*position:\s*absolute[^}]*top:\s*3px[^}]*right:\s*3px[^}]*background:\s*var\(--mndw-control-hover\)/su,
    );
    expect(portColumnSource).toMatch(/\.value\s*\{[^}]*width:\s*100%/su);
    expect(description.querySelector('mndw-icon')).not.toBeNull();
    expect(speed.classList.contains('cell')).toBe(true);
  } finally {
    await harness.close();
  }
});

it('keeps equal column tracks when wide value rows are enabled', async () => {
  const state = defaultState(inventory());

  state.counters['GigabitEthernet0/3'] = {
    ...counterSnapshot(8380, 1_234_567_890_123, 987_654_321_098),
    rxerrors: '123456789',
    rxdropped: '987654321',
  };

  const harness = await createHarness({
    state,
    storedSettings: {
      rows: ['description', 'rx-total', 'tx-total', 'rx-errors', 'rx-dropped'],
    },
  });

  try {
    const grid = harness.target.querySelector<HTMLElement>('.port-grid');
    const port = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"]');

    expect(grid?.getAttribute('style')).toContain('--columns:');
    expect(grid?.getAttribute('style')).not.toMatch(/width|column-width/u);
    expect(port?.querySelector('.rx-total')?.textContent?.trim()).toContain('RX');
    expect(port?.querySelector('.rx-errors')?.textContent).toContain('123456789');
    expect(port?.querySelector('.rx-dropped')?.textContent).toContain('987654321');
    expect(portsWidgetSource).toMatch(
      /\.port-grid\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--columns\),\s*1fr\)[^}]*gap:\s*var\(--mndw-space-3\)[^}]*width:\s*max-content/su,
    );
    expect(portsWidgetSource).not.toMatch(/\.port-grid\s*\{[^}]*min-width:\s*100%/su);
    expect(portsWidgetSource).not.toMatch(/grid-template-columns:\s*repeat\(var\(--columns\),\s*max-content\)/u);
  } finally {
    await harness.close();
  }
});

it('positions port tooltips below, flips above, and clamps horizontally', () => {
  const anchor = {top: 100, right: 150, bottom: 130, left: 100, width: 50, height: 30};
  const tooltip = {width: 80, height: 40};

  expect(computeTooltipCoords(anchor, tooltip, 'bottom', {width: 400, height: 300})).toEqual({
    top: 138,
    left: 85,
    placement: 'bottom',
  });
  expect(computeTooltipCoords(
    {top: 340, right: 150, bottom: 370, left: 100, width: 50, height: 30},
    tooltip,
    'bottom',
    {width: 400, height: 400},
  )).toEqual({top: 292, left: 85, placement: 'top'});
  expect(computeTooltipCoords(
    {top: 100, right: 30, bottom: 130, left: 0, width: 30, height: 30},
    tooltip,
    'bottom',
    {width: 120, height: 300},
  )).toEqual({top: 138, left: 8, placement: 'bottom'});
});

it('positions the fixed port tooltip on row scroll and window resize', async () => {
  const harness = await createHarness();

  try {
    const trigger = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"] .port-trigger');

    if (trigger === null) {
      throw new Error('LAN4 port trigger not rendered');
    }

    const icon = trigger.querySelector<HTMLElement>('mndw-switchport');

    if (icon === null) {
      throw new Error('LAN4 switchport icon not rendered');
    }

    let anchor = {top: 100, right: 74, bottom: 154, left: 20, width: 54, height: 54};

    Object.defineProperty(icon, 'getBoundingClientRect', {
      value: () => anchor as DOMRect,
    });

    trigger?.focus();
    await flush();

    const tooltip = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"] .tooltip');

    expect(tooltip).not.toBeNull();

    if (tooltip === null) {
      return;
    }

    Object.defineProperty(tooltip, 'getBoundingClientRect', {
      value: () => ({width: 100, height: 40}) as DOMRect,
    });
    harness.target.querySelector('.rows-scroll')?.dispatchEvent(new Event('scroll'));
    expect(tooltip.style.left).toBe('8px');
    expect(tooltip.style.top).toBe('162px');

    anchor = {top: 200, right: 254, bottom: 254, left: 200, width: 54, height: 54};
    window.dispatchEvent(new Event('resize'));
    expect(tooltip.style.left).toBe('177px');
    expect(tooltip.style.top).toBe('262px');
    expect(portColumnSource).toMatch(/\.tooltip\s*\{[^}]*position:\s*fixed/su);
  } finally {
    await harness.close();
  }
});

it('does not open a tooltip or hotspot request for a down port', async () => {
  const harness = await createHarness();

  try {
    const trigger = harness.target.querySelector<HTMLElement>('[data-port-id="LAN1"] .port-trigger');

    trigger?.focus();
    await flush();

    expect(harness.target.querySelector('[data-port-id="LAN1"] .tooltip')).toBeNull();
    expect(harness.batches.some((batch) => batch.some((query) => query.path === 'show.ip.hotspot'))).toBe(false);
  } finally {
    await harness.close();
  }
});

it('saves and clears a port name from the rename modal only after Save', async () => {
  const harness = await createHarness();

  try {
    harness.target.querySelector('[data-port-id="LAN4"] .description')?.click();

    const overlay = harness.openedOverlays[0];
    const input = overlay?.target.querySelector<HTMLElement & {value: string}>('mndw-input');

    if (overlay === undefined || input === null) {
      throw new Error('rename modal not rendered');
    }

    input.value = '  Office uplink  ';
    input.dispatchEvent(
      new CustomEvent('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: input.value},
      }),
    );
    overlay.target.querySelector('mndw-button.save')?.click();
    await flush();

    expect(harness.state.rcInterfaces['GigabitEthernet0/3']).toEqual({description: 'Office uplink'});
    expect(harness.target.querySelector('[data-port-id="LAN4"] .description-text')?.textContent).toBe('Office uplink');
    expect(overlay.closed).toBe(true);
    expect(harness.batches.some((batch) => batch.some((query) => query.path === 'interface'))).toBe(true);
    expect(harness.batches.some((batch) => batch.some((query) => query.path === 'system.configuration.save'))).toBe(
      true,
    );

    harness.target.querySelector('[data-port-id="LAN4"] .description')?.click();

    const clearOverlay = harness.openedOverlays[1];

    clearOverlay?.target.querySelector('mndw-button.clear')?.click();
    await flush();

    expect(harness.state.rcInterfaces['GigabitEthernet0/3']).toEqual({description: 'Office uplink'});
    expect(harness.batches.filter((batch) => batch.some((query) => query.path === 'interface'))).toHaveLength(1);

    clearOverlay?.target.querySelector('mndw-button.save')?.click();
    await flush();

    expect(harness.state.rcInterfaces['GigabitEthernet0/3']).toBeUndefined();
    expect(clearOverlay?.closed).toBe(true);

    const writeBatch = harness.batches.findLast((batch) => batch.some((query) => query.path === 'interface'));

    expect(writeBatch?.[0].data?.description).toEqual({no: true});

    harness.target.querySelector('[data-port-id="LAN4"] .description')?.click();

    const cancelOverlay = harness.openedOverlays[2];
    const cancelInput = cancelOverlay?.target.querySelector<HTMLElement & {value: string}>('mndw-input');

    if (cancelOverlay === undefined || cancelInput === null) {
      throw new Error('rename modal not rendered for cancel');
    }

    cancelInput.value = 'Do not save';
    cancelInput.dispatchEvent(
      new CustomEvent('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: cancelInput.value},
      }),
    );
    cancelOverlay.target.querySelector('mndw-button.cancel')?.click();
    await flush();

    expect(harness.state.rcInterfaces['GigabitEthernet0/3']).toBeUndefined();
    expect(harness.batches.filter((batch) => batch.some((query) => query.path === 'interface'))).toHaveLength(2);
    expect(cancelOverlay.closed).toBe(true);
  } finally {
    await harness.close();
  }
});

it('keeps validation and router errors inside the rename modal', async () => {
  const harness = await createHarness();

  try {
    harness.target.querySelector('[data-port-id="LAN4"] .description')?.click();

    const overlay = harness.openedOverlays[0];
    const input = overlay?.target.querySelector<HTMLElement & {value: string}>('mndw-input');

    if (overlay === undefined || input === null) {
      throw new Error('rename modal not rendered');
    }

    input.value = 'x'.repeat(65);
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}}));
    overlay.target.querySelector('mndw-button.save')?.click();
    await flush();

    expect(overlay.target.querySelector('[role="alert"]')?.textContent).toContain('64 characters or fewer');
    expect(harness.batches.some((batch) => batch.some((query) => query.path === 'interface'))).toBe(false);

    input.value = 'Office uplink';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}}));
    harness.state.fail = true;
    overlay.target.querySelector('mndw-button.save')?.click();
    await flush();

    expect(overlay.target.querySelector('[role="alert"]')?.textContent).toContain('rci unavailable');
    expect(overlay.closed).toBe(false);
  } finally {
    await harness.close();
  }
});

it('moves, removes, and adds ordered settings rows and persists each change', async () => {
  const harness = await createHarness();

  try {
    harness.target.querySelector('.settings-button')?.click();

    const overlay = harness.openedOverlays[0];

    if (overlay === undefined) {
      throw new Error('settings modal not rendered');
    }

    expect(overlay.title).toBe('Port display settings');

    const rowNames = (): string[] =>
      Array.from(overlay.target.querySelectorAll('.rows .row-name'))
        .map((row) => row.textContent?.trim() ?? '');

    expect(rowNames()).toEqual(['Description', 'Speed', 'Duplex']);

    const firstButton = overlay.target.querySelector<HTMLElement & {disabled: boolean}>(
      '.rows li:first-child mndw-button',
    );
    const lastButton = overlay.target.querySelector<HTMLElement & {disabled: boolean}>(
      '.rows li:last-child mndw-button:nth-of-type(2)',
    );

    expect(firstButton?.disabled).toBe(true);
    expect(lastButton?.disabled).toBe(true);

    overlay.target.querySelector('mndw-button[aria-label="Move Description down"]')?.click();
    await flush();
    expect(rowNames()).toEqual(['Speed', 'Description', 'Duplex']);
    overlay.target.querySelector('mndw-button[aria-label="Remove Duplex"]')?.click();
    await flush();
    expect(rowNames()).toEqual(['Speed', 'Description']);
    overlay.target.querySelector('mndw-select')?.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: 'rx-total'},
      }),
    );
    overlay.target.querySelector('mndw-button[variant="primary"]')?.click();
    await flush();
    expect(rowNames()).toEqual(['Speed', 'Description', 'Received total']);
    await flush();

    await expect(harness.fixture.context.storage.instance.get('line-settings')).resolves.toBe(
      JSON.stringify({rows: ['speed', 'description', 'rx-total']}),
    );
  } finally {
    await harness.close();
  }
});

it('falls back from legacy settings and restores valid ordered rows', async () => {
  const harness = await createHarness({
    storedSettings: {name: false, duplex: false, speed: false, traffic: 'none', errors: false},
  });

  try {
    const port = harness.target.querySelector('[data-port-id="LAN4"]');

    expect(port?.querySelector('.description')).not.toBeNull();
    expect(port?.querySelector('.duplex')).not.toBeNull();
    expect(port?.querySelector('.speed')).not.toBeNull();
    expect(harness.target.querySelector('.settings-button')?.getAttribute('aria-label')).toBe('Port display settings');

    harness.target.querySelector('.settings-button')?.click();
    expect(harness.openedOverlays[0]?.target.querySelectorAll('.rows .row-name')).toHaveLength(3);
  } finally {
    await harness.close();
  }
});

it('hides the description rename row when descriptions are not configured', async () => {
  const harness = await createHarness({storedSettings: {rows: ['speed']}});

  try {
    expect(harness.target.querySelectorAll('.description')).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it('hides Add when eight valid rows are configured', async () => {
  const harness = await createHarness({
    storedSettings: {
      rows: ['description', 'speed', 'duplex', 'rx-total', 'tx-total', 'rx-rate', 'tx-rate', 'separator'],
    },
  });

  try {
    harness.target.querySelector('.settings-button')?.click();

    expect(harness.openedOverlays[0]?.target.querySelectorAll('.rows li')).toHaveLength(8);
    expect(harness.openedOverlays[0]?.target.querySelector('mndw-select')).toBeNull();
  } finally {
    await harness.close();
  }
});

it('draws every configured row for every port and leaves zero errors empty', async () => {
  const harness = await createHarness({
    storedSettings: {
      rows: ['description', 'speed', 'rx-total', 'rx-errors', 'tx-errors', 'rx-dropped', 'tx-dropped', 'separator'],
    },
  });

  try {
    const portColumns = [...harness.target.querySelectorAll<HTMLElement>('[data-port-id]')];

    expect(portColumns).toHaveLength(6);
    expect(portColumns.every((port) => port.querySelectorAll('.cell').length === 8)).toBe(true);
    expect(harness.target.querySelector('[data-port-id="LAN1"] .speed')?.textContent?.trim()).toBe('—');
    expect(harness.target.querySelector('[data-port-id="LAN1"] .description-text')?.textContent).toBe('');
    expect(harness.target.querySelector('[data-port-id="LAN4"] .rx-total')?.textContent).toContain('RX 1.8 GB');
    expect(harness.target.querySelector('[data-port-id="LAN4"] .rx-errors')?.textContent?.trim()).toBe('');
    expect(harness.target.querySelector('[data-port-id="LAN4"] .tx-errors')?.textContent).toContain('TXErr 3');
    expect(harness.target.querySelector('[data-port-id="LAN4"] .rx-dropped')?.textContent).toContain('RXDrop 1');
    expect(harness.target.querySelector('[data-port-id="LAN4"] .tx-dropped')?.textContent?.trim()).toBe('');
    expect(harness.target.querySelector('[data-port-id="LAN1"] .rx-errors')?.textContent?.trim()).toBe('');
  } finally {
    await harness.close();
  }
});

it('shows dashes for unavailable counters but keeps down-port totals', async () => {
  const state = defaultState(inventory());

  delete state.counters['GigabitEthernet0/2'];
  state.counters['GigabitEthernet0/1'] = {txbytes: '250000'};

  const harness = await createHarness({
    state,
    storedSettings: {rows: ['rx-total', 'tx-total', 'rx-rate', 'tx-rate', 'separator']},
  });

  try {
    const downPort = harness.target.querySelector<HTMLElement>('[data-port-id="LAN1"]');
    const missingCounters = harness.target.querySelector<HTMLElement>('[data-port-id="LAN3"]');
    const partialCounters = harness.target.querySelector<HTMLElement>('[data-port-id="LAN2"]');

    expect(downPort?.querySelector('.rx-total')?.textContent).toContain('RX');
    expect(downPort?.querySelector('.tx-total')?.textContent).toContain('TX');
    expect(partialCounters?.querySelector('.rx-total')?.textContent?.trim()).toBe('—');
    expect(partialCounters?.querySelector('.tx-total')?.textContent).toContain('TX');

    for (const kind of ['rx-total', 'tx-total', 'rx-rate', 'tx-rate']) {
      const cell = missingCounters?.querySelector<HTMLElement>(`.${kind}`);

      expect(cell?.textContent?.trim()).toBe('—');
      expect(cell?.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
    }

    expect(missingCounters?.querySelector('.separator')?.textContent?.trim()).toBe('');
    expect(missingCounters?.querySelector('.separator')?.getAttribute('aria-hidden')).toBe('true');
  } finally {
    await harness.close();
  }
});

it('shows receive and send rates in their configured rows after the next poll', async () => {
  const harness = await createHarness({storedSettings: {rows: ['rx-rate', 'tx-rate']}});

  try {
    harness.state.counters['GigabitEthernet0/3'] = counterSnapshot(8397.675819, 1_844_689_407, 987_659_321);
    harness.fixture.tick();
    await flush();

    expect(harness.target.querySelector('[data-port-id="LAN4"] .rx-rate')?.textContent).toContain('RX 12 kbit/s');
    expect(harness.target.querySelector('[data-port-id="LAN4"] .tx-rate')?.textContent).toContain('TX 4 kbit/s');
  } finally {
    await harness.close();
  }
});

it('moves the focus between ports with the arrow keys', async () => {
  const switchports = inventory({
    layout: [['0'], ['1', '2', '3', '4']],
    list: (switchportsFixture as unknown as Switchports).list.slice(0, 5),
  });
  const harness = await createHarness({switchports});
  const trigger = (id: string): HTMLElement => {
    const element = harness.target.querySelector<HTMLElement>(`[data-port-id="${id}"] .port-trigger`);

    if (element === null) {
      throw new Error(`port ${id} not rendered`);
    }

    return element;
  };

  try {
    const triggers = [...harness.target.querySelectorAll<HTMLElement>('.port-trigger')];

    expect(triggers.filter((element) => element.tabIndex === 0)).toHaveLength(1);

    trigger('WAN').focus();
    trigger('WAN').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
    expect(document.activeElement).toBe(trigger('LAN1'));

    const scrollIntoView = vi.fn();

    Object.defineProperty(trigger('LAN2'), 'scrollIntoView', {value: scrollIntoView});
    trigger('LAN1').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    expect(document.activeElement).toBe(trigger('LAN2'));
    expect(scrollIntoView).toHaveBeenCalledWith({block: 'nearest', inline: 'nearest'});

    trigger('LAN2').dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true}));
    expect(document.activeElement).toBe(trigger('LAN4'));
    trigger('LAN4').dispatchEvent(new KeyboardEvent('keydown', {key: 'Home', bubbles: true}));
    expect(document.activeElement).toBe(trigger('WAN'));
    expect(harness.target.querySelector('.rows-scroll')?.getAttribute('class')).toContain('rows-scroll');
    expect(portsWidgetSource).toMatch(/\.rows-scroll\s*\{[^}]*overflow:\s*auto/su);
  } finally {
    await harness.close();
  }
});

it('provides one roving description stop and opens rename from that row', async () => {
  const state = defaultState(inventory());

  state.rcInterfaces['GigabitEthernet0/3'] = {description: 'Office uplink'};

  const harness = await createHarness({state});

  try {
    const buttons = [...harness.target.querySelectorAll<HTMLButtonElement>('.description')];
    const lan4 = harness.target.querySelector<HTMLButtonElement>('[data-port-id="LAN4"] .description');

    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(lan4?.getAttribute('aria-label')).toBe('Rename port 4: Office uplink');
    expect(harness.target.querySelector('[data-port-id="LAN1"] .description-text')?.textContent).toBe('');
    expect(harness.target.querySelector('[data-port-id="LAN1"] .description mndw-icon')?.getAttribute('name'))
      .toBe('pencil');

    lan4?.focus();
    lan4?.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
    expect(document.activeElement).toBe(harness.target.querySelector('[data-port-id="LAN3"] .description'));
    (document.activeElement as HTMLButtonElement).dispatchEvent(
      new KeyboardEvent('keydown', {key: 'End', bubbles: true}),
    );
    expect(document.activeElement).toBe(harness.target.querySelector('[data-port-id="LAN5"] .description'));
    (document.activeElement as HTMLButtonElement).click();
    expect(harness.openedOverlays[0]?.title).toBe('Rename port 5');
  } finally {
    await harness.close();
  }
});

it('keeps the last data and marks it stale after a failed poll', async () => {
  const harness = await createHarness();
  const button = (): Element | null => harness.target.querySelector('[data-port-id="LAN4"]');

  try {
    const label = button()?.getAttribute('aria-label');

    harness.state.fail = true;
    harness.fixture.tick();
    await flush();

    expect(harness.target.textContent).toContain('Showing the last known state; the update failed');
    expect(button()?.getAttribute('aria-label')).toBe(label);
    expect(button()?.querySelector('.speed')?.textContent).toContain('100 M');

    harness.state.fail = false;
    harness.fixture.tick();
    await flush();

    expect(harness.target.textContent).not.toContain('Showing the last known state; the update failed');
  } finally {
    await harness.close();
  }
});

it('shows the empty message without polling when the router has no port inventory', async () => {
  const harness = await createHarness({switchports: inventory({list: [], layout: []})});

  try {
    expect(harness.target.textContent).toContain('Port layout is not available for this router');
    expect(harness.target.querySelectorAll('[data-port-id]')).toHaveLength(0);
    expect(harness.batches).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it('omits tooltip totals and stat queries without port statistics', async () => {
  const harness = await createHarness({switchports: inventory({hasPortStats: false})});

  try {
    harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"] .port-trigger')?.focus();
    await flush();

    const text = harness.target.querySelector('.tooltip')?.textContent ?? '';

    expect(text).toContain('Link changed');
    expect(text).toContain('2 hours ago');
    expect(text).not.toContain('RX ');
    expect(harness.batches.some((batch) => batch.some((query) => query.path === 'show.interface.stat'))).toBe(false);
  } finally {
    await harness.close();
  }
});

it('fetches hotspot data on tooltip open and only polls it while a tooltip stays open', async () => {
  const harness = await createHarness();

  try {
    expect(harness.batches).toHaveLength(3);
    expect(harness.batches[0].every((query) => query.path === 'show.interface.ethernet.capabilities')).toBe(true);

    expect(harness.batches[1].map((query) => query.path)).toEqual(['show.rc.interface']);

    const pollQueries = harness.batches[2];

    expect(pollQueries.filter((query) => query.path === 'show.interface')).toHaveLength(6);
    expect(pollQueries.filter((query) => query.path === 'show.interface.stat')).toHaveLength(6);

    expect(harness.batches[2].some((query) => query.path === 'show.ip.hotspot')).toBe(false);
    harness.fixture.tick();
    await flush();

    expect(harness.batches).toHaveLength(4);
    expect(harness.batches[3]).toHaveLength(12);
    expect(harness.batches[3].some((query) => query.path === 'show.ip.hotspot')).toBe(false);

    const trigger = harness.target.querySelector<HTMLElement>('[data-port-id="LAN4"] .port-trigger');

    trigger?.focus();
    await flush();
    expect(harness.batches[4]).toHaveLength(1);
    expect(harness.batches[4][0].path).toBe('show.ip.hotspot');

    harness.fixture.tick();
    await flush();
    expect(harness.batches[5]).toHaveLength(13);
    expect(harness.batches[5].at(-1)?.path).toBe('show.ip.hotspot');

    trigger?.blur();
    await flush();
    harness.fixture.tick();
    await flush();
    expect(harness.batches[6]).toHaveLength(12);
    expect(harness.batches[6].some((query) => query.path === 'show.ip.hotspot')).toBe(false);
  } finally {
    await harness.close();
  }
});

it('updates the host widget title for the active locale', async () => {
  const harness = await createHarness({useInstance: true});

  try {
    expect(harness.fixture.tileTitles.at(-1)).toBe('Ports');

    harness.i18n.setLocale('ru', ruMessages);
    await flush();

    expect(harness.fixture.tileTitles.at(-1)).toBe('Порты');
    expect(harness.target.querySelector('[data-ports-widget]')?.getAttribute('aria-label')).toBe('Порты');
  } finally {
    await harness.close();
  }
});
