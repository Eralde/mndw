// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {setLocale} from '../../../services/locale.service.js';
import CapabilityReview from './CapabilityReview.svelte';

const baseEntry: PluginListEntry = {
  name: 'review-test',
  type: 'widget',
  version: '1.0.0',
  label: 'Review test',
  entry: 'index.js',
  source: 'upload',
  approval: 'pending',
  enabled: false,
  depsStatus: 'ready',
  backend: {routes: {}},
  size: {w: 4, h: 3},
};

function mountReview(entry: PluginListEntry): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(CapabilityReview, {target, props: {entry}});

  flushSync();

  return {component, target};
}

describe('CapabilityReview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders declared route values', () => {
    const {component, target} = mountReview({
      ...baseEntry,
      backend: {
        routes: {
          status: {transport: 'http', method: 'GET', path: 'status'},
          restart: {transport: 'http', method: 'POST', path: 'restart'},
          events: {transport: 'websocket', path: 'events', protocols: ['json', 'cbor']},
          logs: {transport: 'websocket', path: 'logs'},
        },
      },
    });

    expect(target.textContent).toContain('status: GET status');
    expect(target.textContent).toContain('restart: POST restart');
    expect(target.textContent).toContain('events: events (json, cbor)');
    expect(target.textContent).toContain('logs: logs');

    void unmount(component);
  });

  it('updates capability labels after a locale commit', async () => {
    const {component, target} = mountReview({
      ...baseEntry,
      backend: {routes: {status: {transport: 'http', method: 'GET', path: 'status'}}},
    });

    try {
      expect(target.textContent).toContain('Routes');

      await setLocale('ru');
      flushSync();

      expect(target.textContent).toContain('Маршруты');
    } finally {
      await unmount(component);
      await setLocale('en');
    }
  });

  it('renders no route section for an empty descriptor', () => {
    const {component, target} = mountReview(baseEntry);

    expect(target.textContent).not.toContain('Routes');

    void unmount(component);
  });
});

describe('CapabilityReview capability summary', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders backend kind, packages, args, public routes, and permissions', () => {
    const {component, target} = mountReview({
      ...baseEntry,
      review: {kind: 'service', packages: ['ttyd'], args: ['--foreground'], publicRoutes: ['health']},
      permissions: ['persistent-rci-session:read'],
      backend: {routes: {health: {transport: 'http', method: 'GET', path: 'health'}}},
    });

    expect(target.textContent).toContain('Runs a resident background process as root');
    expect(target.textContent).toContain('ttyd');
    expect(target.textContent).toContain('--foreground');
    expect(target.textContent).toContain('Public routes');
    expect(target.textContent).toContain('health');
    expect(target.textContent).toContain('persistent-rci-session:read');

    void unmount(component);
  });

  it('omits sections the plugin does not declare', () => {
    const {component, target} = mountReview({
      ...baseEntry,
      review: {kind: 'exec'},
      backend: {routes: {run: {transport: 'http', method: 'GET', path: 'run'}}},
    });

    expect(target.textContent).toContain('Runs commands as root on each request');
    expect(target.textContent).not.toContain('Installs packages');
    expect(target.textContent).not.toContain('Service arguments');
    expect(target.textContent).not.toContain('Public routes');
    expect(target.textContent).not.toContain('Permissions');

    void unmount(component);
  });

  it('renders an SDK compatibility warning from the plugin lock', () => {
    const {component, target} = mountReview({
      ...baseEntry,
      lock: {sdkVersion: '2.0.0', sharedDependencies: {}},
    });

    expect(target.textContent).toContain('Version compatibility');
    expect(target.textContent).toContain('Built for @mndw/sdk 2.0.0');
    expect(target.textContent).toContain('this dashboard provides 1.0.0');
    expect(target.textContent).toContain('You can still install it.');

    void unmount(component);
  });

  it('uses neutral major-mismatch copy in English and Russian', async () => {
    const {component, target} = mountReview({
      ...baseEntry,
      lock: {sdkVersion: '2.0.0', sharedDependencies: {}},
    });
    const warning = target.querySelector<HTMLElement>('.mndw-version-warning');
    const sdkWarning = target.querySelector<HTMLElement>('.mndw-version-warning li');

    try {
      await setLocale('en');
      flushSync();

      expect(sdkWarning?.textContent?.toLowerCase()).not.toContain('newer');

      await setLocale('ru');
      flushSync();

      expect(sdkWarning?.textContent?.toLowerCase()).not.toContain('нов');
      expect(warning?.textContent).toContain('Совместимость версий');
    } finally {
      await unmount(component);
      await setLocale('en');
    }
  });
});
