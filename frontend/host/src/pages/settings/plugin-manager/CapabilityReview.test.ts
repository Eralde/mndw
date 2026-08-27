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

  it('renders declared route values', () => {
    const {component, target} = mountReview({
      routes: {
        status: {transport: 'http', method: 'GET', path: 'status'},
        restart: {transport: 'http', method: 'POST', path: 'restart'},
        events: {transport: 'websocket', path: 'events', protocols: ['json', 'cbor']},
        logs: {transport: 'websocket', path: 'logs'},
      },
    });

    expect(target.textContent).toContain('status: GET status');
    expect(target.textContent).toContain('restart: POST restart');
    expect(target.textContent).toContain('events: events (json, cbor)');
    expect(target.textContent).toContain('logs: logs');

    void unmount(component);
  });

  it('renders no route section for an empty descriptor', () => {
    const {component, target} = mountReview({
      routes: {},
    });

    expect(target.textContent).not.toContain('Routes');

    void unmount(component);
  });
});
