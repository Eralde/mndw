// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {ServiceEntry} from '../../services/service-client.js';
import {appState} from '../../state/app.svelte.js';
import type {ServiceRow} from './service-row.js';
import ServiceActionsCell from './ServiceActionsCell.svelte';
import ServiceAutostartCell from './ServiceAutostartCell.svelte';
import ServiceNameCell from './ServiceNameCell.svelte';
import ServiceStateCell from './ServiceStateCell.svelte';
import type {ServiceAction} from './service-actions-renderer.svelte.js';

function entry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    name: 'nginx',
    label: 'nginx',
    state: 'running',
    enabledAtBoot: true,
    protected: false,
    autostartPinned: false,
    ...overrides,
  } as ServiceEntry;
}

let host: HTMLElement;
let previousLocale: string;

beforeEach(() => {
  previousLocale = appState.locale;
  appState.locale = 'en';
  defineMndwUi();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  appState.locale = previousLocale;
  host.remove();
});

describe('ServiceStateCell', () => {
  it.each(
    [
      {locale: 'en', state: 'running', label: 'Running'},
      {locale: 'en', state: 'stopped', label: 'Stopped'},
      {locale: 'en', state: 'unknown', label: 'Unknown'},
      {locale: 'ru', state: 'running', label: 'Работает'},
      {locale: 'ru', state: 'stopped', label: 'Остановлен'},
      {locale: 'ru', state: 'unknown', label: 'Неизвестно'},
    ] as const,
  )('translates $state in $locale', async ({locale, state, label}) => {
    appState.locale = locale;

    const row: ServiceRow = {service: entry({state, pid: 42}), busy: false, rowError: false, compact: false};
    const app = mount(ServiceStateCell, {target: host, props: {row}});

    flushSync();

    expect(host.querySelector(`.badge-${state}`)).not.toBeNull();
    expect(host.querySelector('.badge')?.textContent).toBe(label);
    expect(host.textContent).toContain('42');
    await unmount(app);
  });

  it.each(
    [
      {locale: 'en', label: 'Unknown'},
      {locale: 'ru', label: 'Неизвестно'},
    ] as const,
  )('shows translated probe-failed label in $locale', async ({locale, label}) => {
    appState.locale = locale;

    const row: ServiceRow = {service: entry({state: 'unknown'}), busy: false, rowError: true, compact: false};
    const app = mount(ServiceStateCell, {target: host, props: {row}});

    flushSync();

    expect(host.querySelector('.badge-unknown')).not.toBeNull();
    expect(host.querySelector('.badge')?.textContent).toBe(label);
    await unmount(app);
  });
});

describe('ServiceNameCell', () => {
  it('renders the label prominently and the service name as a sub-line', async () => {
    const row: ServiceRow = {service: entry({label: 'Nginx', name: 'nginx'}), busy: false, rowError: false,
      compact: false};
    const app = mount(ServiceNameCell, {target: host, props: {row, onToggle: () => {}}});

    flushSync();

    expect(host.querySelector('strong')?.textContent).toBe('Nginx');
    expect(host.querySelector('small')?.textContent).toBe('nginx');
    await unmount(app);
  });
});

describe('ServiceAutostartCell', () => {
  it('reverts the switch to enabledAtBoot on change and reports the intended value exactly once', async () => {
    const row: ServiceRow = {service: entry({enabledAtBoot: true}), busy: false, rowError: false, compact: false};
    const reported: boolean[] = [];
    const app = mount(ServiceAutostartCell, {
      target: host,
      props: {row, onToggle: (enabled: boolean) => reported.push(enabled)},
    });

    flushSync();

    const control = host.querySelector<HTMLElement & {checked: boolean}>('mndw-switch');

    if (control === null) {
      throw new Error('switch not rendered');
    }

    control.click();
    flushSync();

    expect(reported).toEqual([false]);
    expect(control.checked).toBe(true);
    await unmount(app);
  });

  it('disables the switch when the row is busy, protected, or pinned', async () => {
    const row: ServiceRow = {service: entry({protected: true}), busy: false, rowError: false, compact: false};
    const app = mount(ServiceAutostartCell, {target: host, props: {row, onToggle: () => {}}});

    flushSync();

    const control = host.querySelector<HTMLElement & {disabled: boolean}>('mndw-switch');

    expect(control?.disabled).toBe(true);
    await unmount(app);
  });
});

describe('ServiceActionsCell', () => {
  it.each(
    [
      {state: 'running', rowError: false, expected: ['Stop', 'Restart']},
      {state: 'stopped', rowError: false, expected: ['Start']},
      {state: 'unknown', rowError: false, expected: ['Start', 'Stop', 'Restart']},
      {state: 'running', rowError: true, expected: ['Start', 'Stop', 'Restart']},
    ] as const,
  )('shows state-appropriate actions for $state (probe error: $rowError)', async ({state, rowError, expected}) => {
    const row: ServiceRow = {service: entry({state}), busy: false, rowError, compact: false};
    const runs: ServiceAction[] = [];
    const app = mount(ServiceActionsCell, {
      target: host,
      props: {row, onRun: (action: ServiceAction) => runs.push(action)},
    });

    flushSync();

    const buttons = Array.from(host.querySelectorAll<HTMLElement>('mndw-button'));
    const labels = buttons.map((button) => button.textContent?.trim());

    expect(labels).toEqual(expected);
    buttons.find((button) => button.textContent?.trim() === 'Stop')
      ?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    expect(runs).toEqual(labels.includes('Stop') ? ['stop'] : []);
    await unmount(app);
  });

  it('replaces protected Stop and Restart with an accessible label', async () => {
    const row: ServiceRow = {service: entry({protected: true}), busy: false, rowError: false, compact: false};
    const app = mount(ServiceActionsCell, {target: host, props: {row, onRun: () => {}}});

    flushSync();

    const label = host.querySelector('.protected-label');

    expect(host.querySelectorAll('mndw-button')).toHaveLength(0);
    expect(label?.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('Protected');
    expect(label?.querySelector('.mndw-visually-hidden')?.textContent?.trim()).toBe('Protected service');
    expect(label?.getAttribute('title')).toBe('Protected service');
    expect(label?.getAttribute('aria-label')).toBeNull();
    await unmount(app);
  });

  it('keeps Start for a stopped protected service', async () => {
    const row: ServiceRow = {service: entry({state: 'stopped', protected: true}), busy: false, rowError: false,
      compact: false};
    const app = mount(ServiceActionsCell, {target: host, props: {row, onRun: () => {}}});

    flushSync();

    const buttons = Array.from(host.querySelectorAll<HTMLElement & {disabled: boolean}>('mndw-button'));

    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Start']);
    expect(buttons[0]?.disabled).toBe(false);
    expect(
      host.querySelector('.protected-label [aria-hidden="true"]')?.textContent?.trim(),
    ).toBe('Protected');
    await unmount(app);
  });

  it('keeps visible actions disabled while busy', async () => {
    const row: ServiceRow = {service: entry(), busy: true, rowError: false, compact: false};
    const app = mount(ServiceActionsCell, {target: host, props: {row, onRun: () => {}}});

    flushSync();

    const buttons = Array.from(host.querySelectorAll<HTMLElement & {disabled: boolean}>('mndw-button'));

    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await unmount(app);
  });
});
