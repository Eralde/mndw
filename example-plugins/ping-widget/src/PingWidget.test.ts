// @vitest-environment happy-dom
import {flushSync, mount, settled, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import PingWidget from './PingWidget.svelte';

function backendReturning(byId: Record<string, unknown>) {
  const fetchMock = vi.fn((id: string) =>
    Promise.resolve(
      new Response(JSON.stringify({success: true, data: byId[id] ?? []}), {
        headers: {'content-type': 'application/json'},
      }),
    )
  );

  return {backend: {fetch: fetchMock} as unknown as BackendClient, fetchMock};
}

describe('PingWidget', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => host.remove());

  it('renders "unavailable" when backend is undefined', async () => {
    const app = mount(PingWidget, {target: host, props: {backend: undefined}});

    flushSync();

    expect(host.textContent).toMatch(/unavailable/i);
    await unmount(app);
  });

  it('loads stats and hosts on mount', async () => {
    const {backend, fetchMock} = backendReturning({
      stats: [],
      hosts: [{ip: '9.9.9.9', name: 'dns'}],
    });
    const app = mount(PingWidget, {target: host, props: {backend}});

    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('9.9.9.9');
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Data refreshed');
    });
    await settled();

    expect(fetchMock).toHaveBeenCalledWith('stats');
    expect(fetchMock).toHaveBeenCalledWith('hosts');
    await unmount(app);
  });
});
