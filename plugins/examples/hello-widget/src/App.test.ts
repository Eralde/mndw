import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type BackendClient, BackendDisabled, BackendError, BackendNotApproved, BackendUnavailable} from '@mndw/sdk';
import {createTestPluginContext} from '@mndw/sdk/testing';
import App from './App.svelte';
import {createContainer, createI18n} from './test-helpers.js';

const mounted: Array<ReturnType<typeof mount>> = [];

function mountApp(backend: BackendClient, signal = new AbortController().signal): HTMLElement {
  const container = createContainer();

  mounted.push(mount(App, {target: container, props: {backend, i18n: createI18n(), signal}}));
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
    const container = mountApp({call: vi.fn()} as unknown as BackendClient);

    expect(container.querySelector('[data-testid="greet"]')?.tagName).toBe('MNDW-BUTTON');
  });

  it('fetches and renders a non-empty greeting message', async () => {
    const signal = new AbortController().signal;
    const call = vi.fn().mockResolvedValue({message: 'hello from the test'});
    const container = mountApp({call} as unknown as BackendClient, signal);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toBe('hello from the test'));
    expect(call).toHaveBeenCalledWith('hello', {as: 'json', signal});
    expect(container.querySelector('[role="status"]')?.textContent).toBe('hello from the test');
  });

  it('shows the generic error for a non-OK response', async () => {
    const call = vi.fn().mockRejectedValue(new BackendError('HTTP 503', 'HTTP_ERROR', 'hello', {status: 503}));
    const container = mountApp({call} as unknown as BackendClient);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load the greeting.');
  });

  it.each(
    [
      [
        'invalid JSON',
        new BackendError('Invalid JSON', 'INVALID_RESPONSE', 'hello', {status: 200}),
        'Could not load the greeting.',
      ],
      ['missing message', undefined, 'Could not load the greeting.'],
    ] as const,
  )('shows the generic error for %s', async (_name, error, expectedMessage) => {
    const call = error === undefined
      ? vi.fn().mockResolvedValue({message: ''})
      : vi.fn().mockRejectedValue(error);
    const container = mountApp({call} as unknown as BackendClient);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expectedMessage);
  });

  it('shows the generic error for an undeclared backend', async () => {
    const fixture = createTestPluginContext();
    const container = mountApp(fixture.context.backend);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load the greeting.');
    fixture.unmount();
  });

  it.each([
    [BackendNotApproved, 'Approve the backend before running it.'],
    [BackendDisabled, 'Enable the backend before running it.'],
    [BackendUnavailable, 'Backend is temporarily unavailable.'],
    [Error, 'Could not load the greeting.'],
  ])('shows the actionable message for %s', async (ErrorType, message) => {
    const call = vi.fn().mockRejectedValue(new ErrorType('hello'));
    const container = mountApp({call} as unknown as BackendClient);

    clickGreet(container);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
  });

  it('does not let a pending request update state after component teardown', async () => {
    let resolveCall: (value: {message: string}) => void = () => undefined;
    const call = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );
    const controller = new AbortController();
    const container = mountApp({call} as unknown as BackendClient, controller.signal);
    const app = mounted.pop();

    if (app === undefined) {
      throw new Error('Expected mounted component');
    }

    container.querySelector<HTMLElement>('[data-testid="greet"]')?.click();
    flushSync();
    controller.abort();
    await unmount(app);
    resolveCall({message: 'late greeting'});
    await Promise.resolve();

    expect(container.childElementCount).toBe(0);
  });
});
