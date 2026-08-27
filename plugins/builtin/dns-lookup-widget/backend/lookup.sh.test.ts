import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const SCRIPT = resolve(import.meta.dirname, 'lookup.sh');

interface CgiRun {
  status: number | null;
  headers: string;
  body: Record<string, unknown>;
}

function run(env: Record<string, string>): CgiRun {
  const result = spawnSync('sh', [SCRIPT], {
    encoding: 'utf8',
    env: {...process.env, GODEBUG: 'netdns=go', ...env},
  });

  if (result.error) {
    throw result.error;
  }

  const out = result.stdout;
  const crlf = out.indexOf('\r\n\r\n');
  const [sep, sepLen] = crlf >= 0 ? [crlf, 4] : [out.indexOf('\n\n'), 2];

  if (sep < 0) {
    throw new Error(`no CGI header separator in script output: ${JSON.stringify(out)}`);
  }

  return {
    status: result.status,
    headers: out.slice(0, sep),
    body: JSON.parse(out.slice(sep + sepLen).trim()) as Record<string, unknown>,
  };
}

describe('lookup.sh', () => {
  it('resolves localhost with addresses and duration', () => {
    const {status, headers, body} = run({
      REQUEST_METHOD: 'GET',
      QUERY_STRING: 'hostname=localhost',
    });

    expect(status).toBe(0);
    expect(headers).toContain('Content-Type: application/json');
    expect(body.success).toBe(true);
    expect(body.hostname).toBe('localhost');
    expect(Array.isArray(body.addresses)).toBe(true);
    expect((body.addresses as string[]).length).toBeGreaterThan(0);
    expect(typeof body.durationMs).toBe('number');
  });

  it('forwards NXDOMAIN from the deterministic Go-binary fixture', () => {
    const {status, body} = run({
      REQUEST_METHOD: 'GET',
      QUERY_STRING: 'hostname=this-does-not-exist-xyzzy.invalid',
      MNDW_LOOKUP_TEST_BINARY: resolve(import.meta.dirname, 'lookup-test-dns-util.sh'),
    });

    expect(status).toBe(0);
    expect(body).toMatchObject({success: false, error: 'NXDOMAIN'});
  });

  it('escapes multiline stderr as a valid JSON error field', () => {
    const {status, body} = run({
      REQUEST_METHOD: 'GET',
      QUERY_STRING: 'hostname=example.com',
      MNDW_LOOKUP_TEST_BINARY: resolve(import.meta.dirname, 'lookup-test-dns-util-multiline.sh'),
    });

    expect(status).toBe(0);
    expect(body).toMatchObject({
      success: false,
      error: 'LOOKUP_FAILED',
      raw: 'lookup failed: backslash=\\ quote=" tab=\t carriage=\r\nsecond line',
    });
  });

  it('preserves nested JSON text in the raw error field', () => {
    const {status, body} = run({
      REQUEST_METHOD: 'GET',
      QUERY_STRING: 'hostname=example.com',
      MNDW_LOOKUP_TEST_BINARY: resolve(import.meta.dirname, 'lookup-test-dns-util-nested-json.sh'),
    });

    expect(status).toBe(0);
    expect(body).toMatchObject({
      success: false,
      error: 'LOOKUP_FAILED',
      raw: '{"reason":"blocked","details":"line 1\\nline 2"}',
    });
  });

  it('decodes a percent-encoded IPv6 hostname before lookup', () => {
    const {status, body} = run({
      REQUEST_METHOD: 'GET',
      QUERY_STRING: 'hostname=%3A%3A1',
    });

    expect(status).toBe(0);
    expect(body.success).toBe(true);
    expect(body.addresses).toContain('::1');
  });

  it('forwards malformed URL encoding as a structured error', () => {
    const {status, body} = run({
      REQUEST_METHOD: 'GET',
      QUERY_STRING: 'hostname=%ZZ',
    });

    expect(status).toBe(0);
    expect(body).toMatchObject({success: false, error: 'INVALID_HOSTNAME_ENCODING'});
  });

  it('returns MISSING_HOSTNAME when query param is empty', () => {
    const {status, body} = run({
      REQUEST_METHOD: 'GET',
      QUERY_STRING: '',
    });

    expect(status).toBe(0);
    expect(body.success).toBe(false);
    expect(body.error).toBe('MISSING_HOSTNAME');
  });

  it('rejects POST with METHOD_NOT_ALLOWED', () => {
    const {status, body} = run({
      REQUEST_METHOD: 'POST',
      QUERY_STRING: 'hostname=example.com',
    });

    expect(status).toBe(0);
    expect(body.success).toBe(false);
    expect(body.error).toBe('METHOD_NOT_ALLOWED');
  });

  it('returns MISSING_HOSTNAME for empty value', () => {
    const {status, body} = run({
      REQUEST_METHOD: 'GET',
      QUERY_STRING: 'hostname=',
    });

    expect(status).toBe(0);
    expect(body.success).toBe(false);
    expect(body.error).toBe('MISSING_HOSTNAME');
  });
});
