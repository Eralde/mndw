// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import TtydWidget from './TtydWidget.svelte';

afterEach(() => vi.restoreAllMocks());

describe('TtydWidget (dev path)', () => {
  it('shows the spawn error when Start Terminal is clicked and ttyd is not installed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({success: false, error: 'ttyd is not installed'}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );

    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TtydWidget, {
      target: host,
      props: {
        spawnEndpoint: '/api/plugins/ttyd-widget/spawn',
        killEndpoint: '/api/plugins/ttyd-widget/kill',
        websocketPath: '/ws/plugins/ttyd-widget/terminal',
      },
    });

    flushSync();

    const startButton = host.querySelector('button');

    expect(startButton?.textContent).toMatch(/start terminal/i);
    startButton?.click();
    await vi.waitFor(() => expect(host.textContent ?? '').toMatch(/not installed/i));
    await unmount(app);
    host.remove();
  });
});
