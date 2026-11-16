// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {type HostServices, createHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';
import {setLocale} from '../../services/locale.service.js';
import type {ControllerTestResult, PersistentRciCapability} from '../../services/persistent-rci-session.service.js';
import GeneralSettings from './GeneralSettings.svelte';

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
    props: {onPermissionStateChange: vi.fn()},
    context: createHostServicesContext(createServices()),
  });
  flushSync();
}

function telemetrySwitch(): HTMLElement & {checked: boolean} {
  const control = target.querySelector<HTMLElement & {checked: boolean}>('#mndw-telemetry-enabled');

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
  await setLocale('en');
});

describe('GeneralSettings telemetry section', () => {
  it('hides telemetry when no persistent session is enabled', async () => {
    render();

    await vi.waitFor(() => {
      expect(target.querySelector('section[aria-label="Persistent RCI session"]')).not.toBeNull();
    });

    expect(target.querySelector('#mndw-telemetry-enabled')).toBeNull();
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

  it('restores the switch and shows an alert when saving telemetry fails', async () => {
    getCapability.mockResolvedValueOnce(enabledCapability);
    setTelemetry.mockRejectedValueOnce(new Error('private failure detail'));

    render();

    await vi.waitFor(() => expect(telemetrySwitch().checked).toBe(false));
    changeTelemetry(true);
    await vi.waitFor(() => expect(setTelemetry).toHaveBeenCalledWith(true));

    await vi.waitFor(() => {
      flushSync();

      const errorAlert = [...target.querySelectorAll('[role="alert"]')].find((alert) => {
        return alert.textContent?.includes('Could not update background telemetry.');
      });

      expect(errorAlert).toBeDefined();
      expect(telemetrySwitch().checked).toBe(false);
    });
    expect(target.textContent).not.toContain('private failure detail');
    expect(reportTelemetryGathering).not.toHaveBeenCalled();
  });
});

describe('GeneralSettings controller-token placeholder', () => {
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
      {locale: 'en', result: 'valid', expected: 'Controller token is valid', alert: false},
      {locale: 'ru', result: 'valid', expected: 'Токен контроллера действителен', alert: false},
      {locale: 'en', result: 'invalid-token', expected: 'Controller token rejected', alert: true},
      {locale: 'ru', result: 'invalid-token', expected: 'Токен контроллера отклонён', alert: true},
      {
        locale: 'en',
        result: 'unsupported-firmware',
        expected: 'Update device firmware to enable persistent RCI sessions.',
        alert: true,
      },
      {
        locale: 'ru',
        result: 'unsupported-firmware',
        expected: 'Обновите прошивку устройства для включения постоянных сеансов rci/.',
        alert: true,
      },
      {locale: 'en', result: 'unreachable', expected: 'Device unreachable', alert: true},
      {locale: 'ru', result: 'unreachable', expected: 'Устройство недоступно', alert: true},
    ] as const,
  )('shows translated $result result in $locale', async ({locale, result, expected, alert}) => {
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

        expect(resultParagraph).toBeDefined();
        expect(resultParagraph?.getAttribute('role') === 'alert').toBe(alert);

        if (alert && result !== 'unsupported-firmware') {
          expect(resultParagraph?.classList.contains('unsupported-banner')).toBe(true);
        }
      });
    } finally {
      await setLocale('en');
    }
  });
});
