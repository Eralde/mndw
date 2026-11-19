// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {type HostServices, createHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {toast} from '../../services/toast/toast.svelte.js';
import {createTestLocaleController} from '../../testing/test-locale.js';
import type {ControllerTestResult, PersistentRciCapability} from '../../services/persistent-rci-session.service.js';
import GeneralSettings from './GeneralSettings.svelte';

const {services: localeServices, setLocale} = createTestLocaleController();

const getCapability = vi.fn<() => Promise<PersistentRciCapability>>();
const testController = vi.fn<(token: string) => Promise<ControllerTestResult>>();
const getTelemetry = vi.fn<() => Promise<{enabled: boolean}>>();
const setTelemetry = vi.fn<(enabled: boolean) => Promise<void>>();
const reportTelemetryGathering = vi.fn<(enabled: boolean) => void>();
const refreshPalette = vi.fn<() => Promise<void>>();

const disabledCapability: PersistentRciCapability = {
  store: {state: 'empty'},
  controller: {support: 'supported', auth: 'none', enabled: false},
  extenders: [],
  stale: false,
};

const enabledCapability: PersistentRciCapability = {
  ...disabledCapability,
  controller: {...disabledCapability.controller, enabled: true},
};

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;

function createServices(): HostServices {
  const services = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});

  vi.spyOn(services.persistentRci, 'getCapability').mockImplementation(getCapability);
  vi.spyOn(services.persistentRci, 'testController').mockImplementation(testController);

  return {
    ...services,
    locale: localeServices.locale,
    mgmtClient: {...services.mgmtClient, getTelemetry, setTelemetry},
    telemetryGathering: {...services.telemetryGathering, report: reportTelemetryGathering},
    palette: {...services.palette, refreshPalette},
    persistentRci: services.persistentRci,
  };
}

function render(): void {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(GeneralSettings, {
    target,
    props: {onCapabilityStateChange: vi.fn()},
    context: createHostServicesContext(createServices()),
  });
  flushSync();
}

function telemetrySwitch(): HTMLElement & {checked: boolean; disabled: boolean} {
  const control = target.querySelector<HTMLElement & {checked: boolean; disabled: boolean}>(
    '#mndw-telemetry-enabled',
  );

  if (control === null) {
    throw new Error('telemetry switch not rendered');
  }

  return control;
}

function changeTelemetry(enabled: boolean): void {
  telemetrySwitch().dispatchEvent(
    new CustomEvent('mndwchange', {
      bubbles: true,
      composed: true,
      detail: {checked: enabled},
    }),
  );
  flushSync();
}

beforeAll(() => {
  defineMndwUi();
});

beforeEach(() => {
  toast.clear();
  getCapability.mockReset().mockResolvedValue(disabledCapability);
  testController.mockReset();
  getTelemetry.mockReset().mockResolvedValue({enabled: false});
  setTelemetry.mockReset().mockResolvedValue(undefined);
  reportTelemetryGathering.mockReset();
  refreshPalette.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  if (component !== undefined) {
    await unmount(component);
    component = undefined;
  }

  document.body.innerHTML = '';
  toast.clear();
  await setLocale('en');
});

describe('GeneralSettings telemetry section', () => {
  it('keeps telemetry visible and disabled until background router access is enabled', async () => {
    let resolveCapability: (capability: PersistentRciCapability) => void = () => {};

    getCapability.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCapability = resolve;
      }),
    );

    render();

    const routerAccessSection = target.querySelector<HTMLElement>(
      '#mndw-background-router-access',
    );
    const telemetrySection = target.querySelector<HTMLElement>('#mndw-telemetry');

    expect(routerAccessSection).not.toBeNull();
    expect(routerAccessSection?.textContent).toContain('Loading background router access…');
    expect(telemetrySection).not.toBeNull();

    resolveCapability(disabledCapability);
    await vi.waitFor(() => expect(telemetrySwitch().disabled).toBe(true));
    expect(telemetrySection?.textContent).toContain(
      'A background router access session is needed for telemetry.',
    );

    const scrollIntoView = vi.fn();

    if (routerAccessSection) {
      Object.defineProperty(routerAccessSection, 'scrollIntoView', {value: scrollIntoView});
    }

    target.querySelector<HTMLAnchorElement>('#mndw-telemetry a')?.click();

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(routerAccessSection);
  });

  it('puts language in Interface and keeps Device to device facts', () => {
    render();

    const sections = [...target.querySelectorAll('section')];
    const interfaceSection = sections.find((section) => section.querySelector('h3')?.textContent === 'Interface');
    const deviceSection = sections.find((section) => section.querySelector('h3')?.textContent === 'Device');

    expect(interfaceSection?.querySelector('mndw-select')).not.toBeNull();
    expect(deviceSection?.querySelector('mndw-select')).toBeNull();
  });

  it('updates an already-mounted heading through its injected locale translator', async () => {
    render();

    const deviceHeading = [...target.querySelectorAll('h3')]
      .find((heading) => heading.textContent === localeServices.locale.hostT('settings.device'));

    expect(deviceHeading?.textContent).toBe('Device');

    await setLocale('ru');

    await vi.waitFor(() => expect(deviceHeading?.textContent).toBe('Устройство'));
  });

  it('shows extender count and access problems in a collapsed summary', async () => {
    getCapability.mockResolvedValueOnce({
      ...enabledCapability,
      extenders: [
        {identity: 'live', name: 'Live extender', eligible: true, state: 'live'},
        {identity: 'blocked', name: 'Blocked extender', eligible: false, reason: 'no-auth-token'},
      ],
    });

    render();

    await vi.waitFor(() => expect(target.querySelector('details')).not.toBeNull());

    const details = target.querySelector<HTMLDetailsElement>('details');

    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('Extenders (2)');
    expect(details?.querySelector('summary')?.textContent).toContain('1 without access');
    expect(details?.textContent).toContain('Blocked extender');

    await setLocale('ru');
    await vi.waitFor(() => expect(details?.querySelector('summary')?.textContent).toContain('Ретрансляторы (2)'));
    expect(details?.querySelector('summary')?.textContent).toContain('без доступа: 1');
  });

  it('counts eligible extenders still establishing access in the collapsed summary', async () => {
    getCapability.mockResolvedValueOnce({
      ...enabledCapability,
      extenders: [
        {identity: 'pending', name: 'Pending extender', eligible: true, state: 'establishing'},
        {identity: 'coming-online', name: 'Coming online', eligible: true},
      ],
    });

    render();

    await vi.waitFor(() => expect(target.querySelector('details')).not.toBeNull());

    const details = target.querySelector<HTMLDetailsElement>('details');

    expect(details?.querySelector('summary')?.textContent).toContain('Extenders (2)');
    expect(details?.querySelector('summary')?.textContent).toContain('2 without access');
  });

  it('reflects the telemetry state returned by the management client', async () => {
    getCapability.mockResolvedValueOnce(enabledCapability);
    getTelemetry.mockResolvedValueOnce({enabled: true});

    render();

    await vi.waitFor(() => expect(telemetrySwitch().checked).toBe(true));
    expect(getTelemetry).toHaveBeenCalledTimes(1);
  });

  it('sends the requested telemetry state to the management client', async () => {
    getCapability.mockResolvedValueOnce(enabledCapability);

    render();

    await vi.waitFor(() => expect(telemetrySwitch().checked).toBe(false));
    changeTelemetry(true);

    await vi.waitFor(() => expect(setTelemetry).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(reportTelemetryGathering).toHaveBeenCalledWith(true));
  });

  it('restores the switch and shows a toast when saving telemetry fails', async () => {
    getCapability.mockResolvedValueOnce(enabledCapability);
    setTelemetry.mockRejectedValueOnce(new Error('private failure detail'));

    render();

    await vi.waitFor(() => expect(telemetrySwitch().checked).toBe(false));
    changeTelemetry(true);
    await vi.waitFor(() => expect(setTelemetry).toHaveBeenCalledWith(true));

    await vi.waitFor(() => {
      expect(toast.toasts[0]).toMatchObject({
        variant: 'error',
        message: 'Could not update background telemetry.',
      });
      expect(telemetrySwitch().checked).toBe(false);
    });
    expect(target.querySelector('.mndw-alert[role="alert"]')).toBeNull();
    expect(target.textContent).not.toContain('private failure detail');
    expect(reportTelemetryGathering).not.toHaveBeenCalled();
  });

  it('offers Retry when the initial telemetry load fails', async () => {
    getTelemetry.mockRejectedValueOnce(new Error('private failure detail'))
      .mockResolvedValueOnce({enabled: true});

    render();

    await vi.waitFor(() => expect(target.textContent).toContain(hostT('settings.telemetry-error')));

    const alert = [...target.querySelectorAll('[role="alert"]')].find((node) => {
      return node.textContent?.includes(hostT('settings.telemetry-error'));
    });
    const retry = [...(alert?.querySelectorAll('mndw-button') ?? [])].find((button) => {
      return button.textContent?.trim() === 'Retry';
    });

    expect(retry).toBeDefined();
    retry?.click();
    await vi.waitFor(() => expect(getTelemetry).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(telemetrySwitch().checked).toBe(true));
    expect(target.querySelector('.mndw-alert[role="alert"]')).toBeNull();
  });

  it('offers Retry when background router access cannot be loaded', async () => {
    getCapability.mockRejectedValueOnce(new Error('private failure detail'))
      .mockResolvedValueOnce(disabledCapability);

    render();

    await vi.waitFor(() => expect(target.textContent).toContain(hostT('settings.persistent-state-unavailable')));

    const alert = [...target.querySelectorAll('[role="alert"]')].find((node) => {
      return node.textContent?.includes(hostT('settings.persistent-state-unavailable'));
    });
    const retry = [...(alert?.querySelectorAll('mndw-button') ?? [])].find((button) => {
      return button.textContent?.trim() === 'Retry';
    });

    expect(retry).toBeDefined();
    retry?.click();
    await vi.waitFor(() => expect(getCapability).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(target.querySelector('.mndw-alert[role="alert"]')).toBeNull());
  });
});

describe('GeneralSettings controller-token placeholder', () => {
  it('links the localized token setup hint to the token input', async () => {
    getCapability.mockResolvedValueOnce({
      ...enabledCapability,
      controller: {support: 'needs-token', auth: 'token', enabled: true},
    });
    await setLocale('en');

    render();

    await vi.waitFor(() => {
      expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull();
    });

    const tokenInput = target.querySelector('mndw-input[type="password"]');
    const hintId = tokenInput?.getAttribute('aria-describedby');

    expect(hintId).toBe('mndw-controller-token-hint');
    expect(target.querySelector(`#${hintId}`)?.textContent?.trim()).toBe(
      'Create a token in the router\'s web interface on the Users & Access page, or in the router\'s command line.',
    );

    await setLocale('ru');
    flushSync();

    expect(target.querySelector(`#${hintId}`)?.textContent?.trim()).toBe(
      'Токен создаётся в веб-интерфейсе роутера на странице «Пользователи и доступ» или в командной строке роутера.',
    );
  });

  it('localizes the configured-token placeholder', async () => {
    getCapability.mockResolvedValueOnce({
      ...enabledCapability,
      controller: {support: 'supported', auth: 'token', enabled: true},
    });
    await setLocale('en');

    render();

    await vi.waitFor(() => {
      expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull();
    });

    const tokenInput = target.querySelector('mndw-input[type="password"]');

    expect(tokenInput?.getAttribute('placeholder')).toBe('Token is set');

    await setLocale('ru');
    flushSync();

    expect(target.firstElementChild?.getAttribute('data-locale')).toBe('ru');
    await vi.waitFor(() => {
      expect(target.querySelector('mndw-input[type="password"]')?.getAttribute('placeholder')).toBe('Токен задан');
    });
  });

  it('keeps the placeholder empty when no controller token is configured', async () => {
    getCapability.mockResolvedValueOnce({
      ...enabledCapability,
      controller: {support: 'needs-token', auth: 'token', enabled: true},
    });

    render();

    await vi.waitFor(() => {
      expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull();
    });

    expect(target.querySelector('mndw-input[type="password"]')?.getAttribute('placeholder')).toBe('');
  });
});

describe('GeneralSettings controller-test results', () => {
  it.each(
    [
      {locale: 'en', result: 'valid', expected: 'Controller token is valid', feedback: 'toast'},
      {locale: 'en', result: 'invalid-token', expected: 'Controller token rejected', feedback: 'alert'},
      {
        locale: 'en',
        result: 'unsupported-firmware',
        expected: 'Update device firmware to enable background router access.',
        feedback: 'status',
      },
      {locale: 'en', result: 'unreachable', expected: 'Device unreachable', feedback: 'toast'},
      {locale: 'ru', result: 'unreachable', expected: 'Устройство недоступно', feedback: 'toast'},
    ] as const,
  )('shows translated $result result in $locale', async ({locale, result, expected, feedback}) => {
    await setLocale(locale);
    getCapability.mockResolvedValueOnce({
      ...enabledCapability,
      controller: {support: 'needs-token', auth: 'token', enabled: true},
    });
    testController.mockResolvedValueOnce({result});
    render();

    try {
      await vi.waitFor(() => {
        expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull();
      });

      const tokenInput = target.querySelector<HTMLElement>('mndw-input[type="password"]');

      tokenInput?.dispatchEvent(
        new CustomEvent('mndwinput', {
          bubbles: true,
          composed: true,
          detail: {value: 'test-token'},
        }),
      );
      flushSync();

      const testButtonLabel = locale === 'en' ? 'Test' : 'Проверить';
      const testButton = [...target.querySelectorAll('mndw-button')].find((button) =>
        button.textContent?.trim() === testButtonLabel
      );

      testButton?.click();

      await vi.waitFor(() => expect(testController).toHaveBeenCalledWith('test-token'));

      await vi.waitFor(() => {
        flushSync();

        const resultParagraph = [...target.querySelectorAll('p')].find((paragraph) =>
          paragraph.textContent?.trim() === expected
        );

        if (feedback === 'toast') {
          expect(resultParagraph).toBeUndefined();
          expect(toast.toasts[0]).toMatchObject({
            variant: result === 'valid' ? 'success' : 'error',
            message: expected,
          });
        } else {
          expect(resultParagraph).toBeDefined();
          expect(resultParagraph?.getAttribute('role')).toBe(feedback);
        }

        if (feedback === 'alert') {
          expect(resultParagraph?.classList.contains('unsupported-banner')).toBe(true);
        }
      });
    } finally {
      await setLocale('en');
    }
  });
});
