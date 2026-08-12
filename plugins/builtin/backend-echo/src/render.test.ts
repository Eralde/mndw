// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import {render} from './render.js';

const i18n = createTestI18n(enCatalog);

function root(): HTMLElement {
  const el = document.createElement('div');

  document.body.append(el);

  return el;
}

describe('render', () => {
  it('shows the HTTP status, echo header, and JSON payload for a result', () => {
    const el = root();

    render(el, {state: 'result', result: {httpStatus: 418, echoHeader: '1', payload: {method: 'GET'}}}, i18n);

    expect(el.querySelector('.mndw-echo__status')?.textContent).toContain('HTTP 418');
    expect(el.querySelector('.mndw-echo__status')?.textContent).toContain('X-Mndw-Echo: 1');
    expect(el.querySelector('.mndw-echo__body')?.textContent).toContain('"method": "GET"');
  });

  it('renders the pending-approval state', () => {
    const el = root();

    render(el, {state: 'pending'}, i18n);

    expect(el.querySelector('.mndw-echo__pending')?.textContent).toContain('pending approval');
  });

  it('renders the disabled state', () => {
    const el = root();

    render(el, {state: 'disabled'}, i18n);

    expect(el.querySelector('.mndw-echo__disabled')?.textContent).toContain('disabled');
  });

  it('renders an error message', () => {
    const el = root();

    render(el, {state: 'error', message: 'boom'}, i18n);

    const alert = el.querySelector('.mndw-alert--danger');

    expect(alert?.textContent).toContain('boom');
    expect(alert?.getAttribute('role')).toBe('alert');
  });

  it('is idempotent — re-rendering replaces prior content', () => {
    const el = root();

    render(el, {state: 'error', message: 'first'}, i18n);
    render(el, {state: 'idle'}, i18n);

    expect(el.querySelector('.mndw-alert--danger')).toBeNull();
    expect(el.querySelector('.mndw-echo__idle')).not.toBeNull();
  });
});
