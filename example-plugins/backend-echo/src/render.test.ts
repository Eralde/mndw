// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {render} from './render.js';

function root(): HTMLElement {
  const el = document.createElement('div');

  document.body.append(el);

  return el;
}

describe('render', () => {
  it('shows the HTTP status, echo header, and JSON payload for a result', () => {
    const el = root();

    render(el, {state: 'result', result: {httpStatus: 418, echoHeader: '1', payload: {method: 'GET'}}});

    expect(el.querySelector('.mndw-echo__status')?.textContent).toContain('HTTP 418');
    expect(el.querySelector('.mndw-echo__status')?.textContent).toContain('X-Mndw-Echo: 1');
    expect(el.querySelector('.mndw-echo__body')?.textContent).toContain('"method": "GET"');
  });

  it('renders the pending-approval state', () => {
    const el = root();

    render(el, {state: 'pending'});

    expect(el.querySelector('.mndw-echo__pending')?.textContent).toContain('pending approval');
  });

  it('renders the disabled state', () => {
    const el = root();

    render(el, {state: 'disabled'});

    expect(el.querySelector('.mndw-echo__disabled')?.textContent).toContain('disabled');
  });

  it('renders an error message', () => {
    const el = root();

    render(el, {state: 'error', message: 'boom'});

    expect(el.querySelector('.mndw-echo__error')?.textContent).toContain('boom');
  });

  it('is idempotent — re-rendering replaces prior content', () => {
    const el = root();

    render(el, {state: 'error', message: 'first'});
    render(el, {state: 'idle'});

    expect(el.querySelector('.mndw-echo__error')).toBeNull();
    expect(el.querySelector('.mndw-echo__idle')).not.toBeNull();
  });
});
