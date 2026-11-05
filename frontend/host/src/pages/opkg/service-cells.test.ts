// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {ServiceEntry} from '../../services/service-client.js';
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

beforeEach(() => {
  defineMndwUi();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('ServiceStateCell', () => {
  it('renders the state with an explicit tone class and a PID when present', async () => {
    const row: ServiceRow = {service: entry({state: 'running', pid: 42}), busy: false, rowError: false};
    const app = mount(ServiceStateCell, {target: host, props: {row}});

    flushSync();

    expect(host.querySelector('.badge-running')).not.toBeNull();
    expect(host.textContent).toContain('running');
    expect(host.textContent).toContain('42');
    await unmount(app);
  });

  it('shows the probe-failed label when the row errored', async () => {
    const row: ServiceRow = {service: entry({state: 'unknown'}), busy: false, rowError: true};
    const app = mount(ServiceStateCell, {target: host, props: {row}});

    flushSync();

    expect(host.textContent).not.toBe('');
    expect(host.querySelector('.badge-unknown')).not.toBeNull();
    await unmount(app);
  });
});

describe('ServiceNameCell', () => {
  it('renders the label prominently and the service name as a sub-line', async () => {
    const row: ServiceRow = {service: entry({label: 'Nginx', name: 'nginx'}), busy: false, rowError: false};
    const app = mount(ServiceNameCell, {target: host, props: {row}});

    flushSync();

    expect(host.querySelector('strong')?.textContent).toBe('Nginx');
    expect(host.querySelector('small')?.textContent).toBe('nginx');
    await unmount(app);
  });
});

describe('ServiceAutostartCell', () => {
  it('reverts the switch to enabledAtBoot on change and reports the intended value exactly once', async () => {
    const row: ServiceRow = {service: entry({enabledAtBoot: true}), busy: false, rowError: false};
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
    const row: ServiceRow = {service: entry({protected: true}), busy: false, rowError: false};
    const app = mount(ServiceAutostartCell, {target: host, props: {row, onToggle: () => {}}});

    flushSync();

    const control = host.querySelector<HTMLElement & {disabled: boolean}>('mndw-switch');

    expect(control?.disabled).toBe(true);
    await unmount(app);
  });
});

describe('ServiceActionsCell', () => {
  it('renders the three actions and reports the clicked one', async () => {
    const row: ServiceRow = {service: entry(), busy: false, rowError: false};
    const runs: ServiceAction[] = [];
    const app = mount(ServiceActionsCell, {
      target: host,
      props: {row, onRun: (action: ServiceAction) => runs.push(action)},
    });

    flushSync();

    const buttons = Array.from(host.querySelectorAll<HTMLElement>('mndw-button'));

    expect(buttons).toHaveLength(3);
    buttons[1]?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    expect(runs).toEqual(['stop']);
    await unmount(app);
  });

  it('disables guarded actions for a protected service', async () => {
    const row: ServiceRow = {service: entry({protected: true}), busy: false, rowError: false};
    const app = mount(ServiceActionsCell, {target: host, props: {row, onRun: () => {}}});

    flushSync();

    const buttons = Array.from(host.querySelectorAll<HTMLElement & {disabled: boolean}>('mndw-button'));

    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[2]?.disabled).toBe(true);
    await unmount(app);
  });
});
