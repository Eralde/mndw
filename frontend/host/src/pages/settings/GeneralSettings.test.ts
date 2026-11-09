// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {type HostServices, createHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';
import type {PersistentRciCapability} from '../../services/persistent-rci-session.service.js';
import GeneralSettings from './GeneralSettings.svelte';

const getCapability = vi.fn<() => Promise<PersistentRciCapability>>();
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
  getTelemetry.mockReset().mockResolvedValue({enabled: false});
  setTelemetry.mockReset().mockResolvedValue(undefined);
  reportTelemetryGathering.mockReset();
  refreshPalette.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (component !== undefined) {
    void unmount(component);
    component = undefined;
  }

  document.body.innerHTML = '';
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
