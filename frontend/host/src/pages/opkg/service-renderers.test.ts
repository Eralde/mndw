import {defineMndwUi} from '@mndw/ui';
import {flushSync} from 'svelte';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {ServiceEntry} from '../../services/service-client.js';
import type {ServiceRow} from './service-row.js';
import {serviceActionsRenderer} from './service-actions-renderer.svelte.js';
import {serviceAutostartRenderer} from './service-autostart-renderer.svelte.js';

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

describe('serviceAutostartRenderer', () => {
  it('mounts a switch and forwards (service, enabled) through the closed-over callback', () => {
    const calls: Array<{name: string; enabled: boolean}> = [];
    const renderer = serviceAutostartRenderer((service, enabled) => calls.push({name: service.name, enabled}))();
    const row: ServiceRow = {service: entry({enabledAtBoot: true}), busy: false, rowError: false};

    renderer.mount({node: host, row, value: undefined, colId: 'autostart'});
    flushSync();

    const control = host.querySelector<HTMLElement & {checked: boolean}>('mndw-switch');

    if (control === null) {
      throw new Error('switch not rendered');
    }

    control.dispatchEvent(new CustomEvent('mndwchange', {detail: {checked: false}}));

    expect(calls).toEqual([{name: 'nginx', enabled: false}]);
    renderer.destroy();
  });
});

describe('serviceActionsRenderer', () => {
  it('forwards (action, name) through the closed-over callback', () => {
    const runs: Array<{action: string; name: string}> = [];
    const renderer = serviceActionsRenderer((action, name) => runs.push({action, name}))();
    const row: ServiceRow = {service: entry({name: 'sshd'}), busy: false, rowError: false};

    renderer.mount({node: host, row, value: undefined, colId: 'actions'});
    flushSync();

    const buttons = Array.from(host.querySelectorAll<HTMLElement>('mndw-button'));

    buttons[0]?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    expect(runs).toEqual([{action: 'start', name: 'sshd'}]);
    renderer.destroy();
  });
});
