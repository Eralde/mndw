// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {type DnsView, render} from './render.js';

function renderView(view: DnsView): string {
  const root = document.createElement('div');

  render(root, view);

  return root.innerHTML;
}

describe('render', () => {
  it('renders idle state', () => {
    const html = renderView({state: 'idle'});

    expect(html).toContain('Enter a hostname');
    expect(html).toContain('dns-lookup-widget__idle');
  });

  it('renders unavailable state', () => {
    const html = renderView({state: 'unavailable'});

    expect(html).toContain('no backend available');
  });

  it('renders loading state with hostname', () => {
    const html = renderView({state: 'loading', hostname: 'example.com'});

    expect(html).toContain('Looking up example.com');
  });

  it('renders error state with message', () => {
    const html = renderView({state: 'error', message: 'timeout'});

    expect(html).toContain('timeout');
    expect(html).toContain('dns-lookup-widget__error');
  });

  it('renders not-found state', () => {
    const html = renderView({state: 'not-found', hostname: 'nope.invalid'});

    expect(html).toContain('not found');
    expect(html).toContain('nope.invalid');
  });

  it('renders result with addresses', () => {
    const html = renderView({
      state: 'result',
      result: {hostname: 'localhost', addresses: ['127.0.0.1', '::1'], durationMs: 1.5},
    });

    expect(html).toContain('localhost');
    expect(html).toContain('1.5 ms');
    expect(html).toContain('127.0.0.1');
    expect(html).toContain('::1');
    expect(html).toContain('dns-lookup-widget__result-addresses');
  });

  it('renders CNAME when different from hostname', () => {
    const html = renderView({
      state: 'result',
      result: {
        hostname: 'www.example.com',
        addresses: ['93.184.215.14'],
        cname: 'example.com.',
        durationMs: 42.0,
      },
    });

    expect(html).toContain('CNAME: example.com.');
  });

  it('omits CNAME when same from hostname', () => {
    const html = renderView({
      state: 'result',
      result: {
        hostname: 'localhost',
        addresses: ['127.0.0.1'],
        cname: 'localhost.',
        durationMs: 1.0,
      },
    });

    expect(html).not.toContain('CNAME:');
  });
});
