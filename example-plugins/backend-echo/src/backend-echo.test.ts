// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BackendDisabled, BackendNotApproved, type PluginContext} from '@mndw/sdk';
import {mountEchoWidget} from './backend-echo.js';

type Backend = NonNullable<PluginContext['backend']>;

function fakeBackend(fetchImpl: Backend['fetch']): Backend {
  return {fetch: fetchImpl, socket: vi.fn()} as unknown as Backend;
}

function container(): HTMLElement {
  const el = document.createElement('div');

  document.body.append(el);

  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('mountEchoWidget', () => {
  it('GET click calls fetch("echoGet") and renders the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({method: 'GET'}), {
        status: 200,
        headers: {'X-Mndw-Echo': '1', 'content-type': 'application/json'},
      }),
    );
    const el = container();

    mountEchoWidget(el, fakeBackend(fetchImpl));

    el.querySelector<HTMLButtonElement>('.mndw-echo__get')?.click();

    await vi.waitFor(() => {
      expect(el.querySelector('.mndw-echo__status')?.textContent).toContain('HTTP 200');
    });
    expect(fetchImpl).toHaveBeenCalledWith('echoGet', {query: undefined, body: undefined});
    expect(el.querySelector('.mndw-echo__body')?.textContent).toContain('"method": "GET"');
  });

  it('threads the status input into the query', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', {status: 418}));
    const el = container();

    mountEchoWidget(el, fakeBackend(fetchImpl));

    const input = el.querySelector<HTMLInputElement>('.mndw-echo__status-input');

    if (input) {
      input.value = '418';
    }

    el.querySelector<HTMLButtonElement>('.mndw-echo__get')?.click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith('echoGet', {query: {status: '418'}, body: undefined});
  });

  it('POST click sends the sample body to "echoPost"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', {status: 200}));
    const el = container();

    mountEchoWidget(el, fakeBackend(fetchImpl));

    el.querySelector<HTMLButtonElement>('.mndw-echo__post')?.click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith('echoPost', {query: undefined, body: {hi: 1}});
  });

  it('renders the pending state when the backend is not approved', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new BackendNotApproved('echoGet'));
    const el = container();

    mountEchoWidget(el, fakeBackend(fetchImpl));

    el.querySelector<HTMLButtonElement>('.mndw-echo__get')?.click();

    await vi.waitFor(() => {
      expect(el.querySelector('.mndw-echo__pending')).not.toBeNull();
    });
  });

  it('renders the disabled state when the backend is disabled', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new BackendDisabled('echoGet'));
    const el = container();

    mountEchoWidget(el, fakeBackend(fetchImpl));

    el.querySelector<HTMLButtonElement>('.mndw-echo__get')?.click();

    await vi.waitFor(() => {
      expect(el.querySelector('.mndw-echo__disabled')).not.toBeNull();
    });
  });

  it('renders unavailable and never fetches when no backend is present', () => {
    const el = container();

    mountEchoWidget(el, undefined);

    el.querySelector<HTMLButtonElement>('.mndw-echo__get')?.click();

    expect(el.querySelector('.mndw-echo__unavailable')).not.toBeNull();
  });
});
