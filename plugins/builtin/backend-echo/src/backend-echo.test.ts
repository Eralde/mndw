// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BackendDisabled, BackendNotApproved, type PluginContext} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import type {MndwButton, MndwInput} from '@mndw/ui';
import {mountEchoWidget} from './backend-echo.js';
import enCatalog from '../i18n/en.json';

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
  it('uses shared input and button controls', () => {
    const el = container();

    mountEchoWidget(el, fakeBackend(vi.fn()), createTestI18n(enCatalog));

    expect(el.querySelector('mndw-input')).not.toBeNull();
    expect(el.querySelectorAll('mndw-button')).toHaveLength(2);
    expect(el.querySelector('input')).toBeNull();
    expect(el.querySelector('button')).toBeNull();
    expect(el.querySelector<MndwInput>('mndw-input')?.type).toBe('number');
    expect([...el.querySelectorAll<MndwButton>('mndw-button')].map((button) => button.variant))
      .toEqual(['primary', 'secondary']);
  });

  it('GET click calls fetch("echoGet") and renders the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({method: 'GET'}), {
        status: 200,
        headers: {'X-Mndw-Echo': '1', 'content-type': 'application/json'},
      }),
    );
    const el = container();

    mountEchoWidget(el, fakeBackend(fetchImpl), createTestI18n(enCatalog));

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

    mountEchoWidget(el, fakeBackend(fetchImpl), createTestI18n(enCatalog));

    const input = el.querySelector<MndwInput>('.mndw-echo__status-input');

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

    mountEchoWidget(el, fakeBackend(fetchImpl), createTestI18n(enCatalog));

    el.querySelector<HTMLButtonElement>('.mndw-echo__post')?.click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith('echoPost', {query: undefined, body: {hi: 1}});
  });

  it('renders the pending state when the backend is not approved', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new BackendNotApproved('echoGet'));
    const el = container();

    mountEchoWidget(el, fakeBackend(fetchImpl), createTestI18n(enCatalog));

    el.querySelector<HTMLButtonElement>('.mndw-echo__get')?.click();

    await vi.waitFor(() => {
      expect(el.querySelector('.mndw-echo__pending')).not.toBeNull();
    });
  });

  it('renders the disabled state when the backend is disabled', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new BackendDisabled('echoGet'));
    const el = container();

    mountEchoWidget(el, fakeBackend(fetchImpl), createTestI18n(enCatalog));

    el.querySelector<HTMLButtonElement>('.mndw-echo__get')?.click();

    await vi.waitFor(() => {
      expect(el.querySelector('.mndw-echo__disabled')).not.toBeNull();
    });
  });

  it('renders unavailable and never fetches when no backend is present', () => {
    const el = container();

    mountEchoWidget(el, undefined, createTestI18n(enCatalog));

    el.querySelector<HTMLButtonElement>('.mndw-echo__get')?.click();

    expect(el.querySelector('.mndw-echo__unavailable')).not.toBeNull();
  });

  it('updates controls and result surface without remounting', () => {
    const i18n = createTestI18n({l10n: {probe: 'Echo English'}, status: 'Status EN', get: 'Get EN', post: 'Post EN',
      idle: 'Idle EN'});
    const el = container();

    mountEchoWidget(el, undefined, i18n);

    const input = el.querySelector<HTMLInputElement>('.mndw-echo__status-input');
    const get = el.querySelector<HTMLButtonElement>('.mndw-echo__get');
    const post = el.querySelector<HTMLButtonElement>('.mndw-echo__post');
    const result = el.querySelector<HTMLElement>('.mndw-echo__result');
    const probe = el.querySelector<HTMLElement>('[data-testid="l10n-probe"]');

    expect(probe?.textContent).toBe('Echo English');
    expect(result?.textContent).toContain('Idle EN');
    i18n.setLocale('ru', {l10n: {probe: 'Эхо русский'}, status: 'Статус RU', get: 'Получить RU', post: 'Отправить RU',
      idle: 'Простой RU'});

    expect(el.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe('Эхо русский');
    expect(input?.placeholder).toBe('Статус RU');
    expect(get?.textContent).toBe('Получить RU');
    expect(post?.textContent).toBe('Отправить RU');
    expect(el.querySelector('.mndw-echo__result')).toBe(result);
    expect(result?.textContent).toContain('Простой RU');
  });
});
