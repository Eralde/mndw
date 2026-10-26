import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type BackendClient, BackendDisabled, BackendNotApproved, BackendUnavailable} from '@mndw/sdk';
import App from './App.svelte';
import {createContainer, createI18n} from './test-helpers.js';

const mounted: Array<ReturnType<typeof mount>> = [];

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {status, headers: {'content-type': 'application/json'}});
}

function mountApp(backend: BackendClient | undefined): HTMLElement {
  const container = createContainer();

  mounted.push(mount(App, {target: container, props: {backend, i18n: createI18n()}}));
  flushSync();

  return container;
}

function clickGreet(container: HTMLElement): void {
  container.querySelector<HTMLElement>('[data-testid="greet"]')?.click();
  flushSync();
}

afterEach(async () => {
  for (const app of mounted.splice(0)) {
    await unmount(app);
  }

  document.body.replaceChildren();
});

describe('Hello widget', () => {
  it('uses the shared UI button for the greeting action', () => {
    const container = mountApp({fetch: vi.fn()} as unknown as BackendClient);

    expect(container.querySelector('[data-testid="greet"]')?.tagName).toBe('MNDW-BUTTON');
  });

  it('fetches and renders a non-empty greeting message', async () => {
    const fetch = vi.fn<BackendClient['fetch']>().mockResolvedValue(response({message: 'hello from the test'}));
    const container = mountApp({fetch} as unknown as BackendClient);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toBe('hello from the test'));
    expect(fetch).toHaveBeenCalledWith('hello');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('hello from the test');
  });

  it('shows the generic error for a non-OK response', async () => {
    const fetch = vi.fn<BackendClient['fetch']>().mockResolvedValue(response({message: 'ignored'}, 503));
    const container = mountApp({fetch} as unknown as BackendClient);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load the greeting.');
  });

  it.each([
    ['invalid JSON', new Response('not json', {status: 200}), 'Could not load the greeting.'],
    ['missing message', response({message: ''}), 'Could not load the greeting.'],
  ])('shows the generic error for %s', async (_name, result, message) => {
    const fetch = vi.fn<BackendClient['fetch']>().mockResolvedValue(result);
    const container = mountApp({fetch} as unknown as BackendClient);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
  });

  it('shows the missing-backend message when no client was provided', async () => {
    const container = mountApp(undefined);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Backend is not available for this plugin.');
  });

  it.each([
    [BackendNotApproved, 'Approve the backend before running it.'],
    [BackendDisabled, 'Enable the backend before running it.'],
    [BackendUnavailable, 'Backend is temporarily unavailable.'],
    [Error, 'Could not load the greeting.'],
  ])('shows the actionable message for %s', async (ErrorType, message) => {
    const fetch = vi.fn<BackendClient['fetch']>().mockRejectedValue(new ErrorType('hello'));
    const container = mountApp({fetch} as unknown as BackendClient);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
  });

  it('does not let a pending request update state after component teardown', async () => {
    let resolveResponse: (value: Response) => void = () => undefined;
    const fetch = vi.fn<BackendClient['fetch']>().mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const container = mountApp({fetch} as unknown as BackendClient);
    const app = mounted.pop();

    if (app === undefined) {
      throw new Error('Expected mounted component');
    }

    container.querySelector<HTMLElement>('[data-testid="greet"]')?.click();
    flushSync();
    await unmount(app);
    resolveResponse(response({message: 'late greeting'}));
    await Promise.resolve();

    expect(container.childElementCount).toBe(0);
  });
});
