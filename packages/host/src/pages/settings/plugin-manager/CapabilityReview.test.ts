import {afterEach, describe, expect, it} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginBackendDescriptor} from '../../../runtime/plugin-types.js';
import CapabilityReview from './CapabilityReview.svelte';

function mountReview(descriptor: PluginBackendDescriptor): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(CapabilityReview, {target, props: {descriptor}});

  flushSync();

  return {component, target};
}

describe('CapabilityReview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders declared capability values without a public warning', () => {
    const {component, target} = mountReview({
      endpoints: {
        status: {method: 'GET', path: '/api/status'},
        restart: {method: 'POST', path: '/api/restart'},
      },
      websockets: {
        events: {path: '/api/events', protocols: ['json', 'cbor']},
        logs: {path: '/api/logs'},
      },
      opkg: ['curl', 'ca-bundle'],
      daemon: true,
      public: false,
    });

    expect(target.textContent).toContain('Packages');
    expect(target.textContent).toContain('curl');
    expect(target.textContent).toContain('ca-bundle');
    expect(target.textContent).toContain('Endpoints');
    expect(target.textContent).toContain('status: GET /api/status');
    expect(target.textContent).toContain('restart: POST /api/restart');
    expect(target.textContent).toContain('WebSockets');
    expect(target.textContent).toContain('events: /api/events (json, cbor)');
    expect(target.textContent).toContain('logs: /api/logs');
    expect(target.textContent).toContain('Daemon declaration');
    expect(target.querySelector('.mndw-cap__public')).toBeNull();

    void unmount(component);
  });

  it('renders a public warning when session-gate bypass is declared', () => {
    const {component, target} = mountReview({
      endpoints: {},
      websockets: {},
      opkg: [],
      daemon: false,
      public: true,
    });

    expect(target.querySelector('.mndw-cap__public')?.textContent).toContain(
      'public: bypasses the session gate',
    );
    expect(target.querySelector('.mndw-cap__public')?.textContent).toContain('reachable without login');
    expect(target.textContent).not.toContain('Packages');
    expect(target.textContent).not.toContain('Endpoints');
    expect(target.textContent).not.toContain('WebSockets');
    expect(target.textContent).not.toContain('Daemon declaration');

    void unmount(component);
  });
});
