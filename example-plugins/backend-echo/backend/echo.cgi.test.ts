import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const SCRIPT = resolve(import.meta.dirname, 'echo.cgi');

interface CgiRun {
  status: number | null;
  headers: string;
  body: string;
}

function run(env: Record<string, string>, stdin = ''): CgiRun {
  const result = spawnSync(SCRIPT, [], {input: stdin, encoding: 'utf8', env: {...process.env, ...env}});

  if (result.error) {
    throw result.error;
  }

  const out = result.stdout;
  // Match the daemon's findHeaderSep: accept either \r\n\r\n or \n\n so the test is
  // no stricter than the runtime contract.
  const crlf = out.indexOf('\r\n\r\n');
  const [sep, sepLen] = crlf >= 0 ? [crlf, 4] : [out.indexOf('\n\n'), 2];

  if (sep < 0) {
    throw new Error(`no CGI header separator in script output: ${JSON.stringify(out)}`);
  }

  return {status: result.status, headers: out.slice(0, sep), body: out.slice(sep + sepLen).trim()};
}

const baseEnv = {
  REQUEST_METHOD: 'GET',
  QUERY_STRING: '',
  CONTENT_TYPE: 'application/json',
  CONTENT_LENGTH: '0',
  MNDW_PLUGIN_ID: 'backend-echo',
  MNDW_ENDPOINT_ID: 'echoGet',
};

describe('echo.cgi', () => {
  it('defaults to Status 200 and always sets the X-Mndw-Echo header', () => {
    const {status, headers, body} = run(baseEnv);

    expect(status).toBe(0);
    expect(headers).toContain('Status: 200');
    expect(headers).toContain('X-Mndw-Echo: 1');
    expect(JSON.parse(body)).toMatchObject({method: 'GET', pluginId: 'backend-echo', endpointId: 'echoGet', body: ''});
  });

  it('honors ?status=NNN and reflects the query string', () => {
    const {headers, body} = run({...baseEnv, QUERY_STRING: 'status=418'});

    expect(headers).toContain('Status: 418');
    expect(JSON.parse(body).query).toBe('status=418');
  });

  it('rejects a non-numeric / out-of-range status back to 200', () => {
    expect(run({...baseEnv, QUERY_STRING: 'status=abc'}).headers).toContain('Status: 200');
    expect(run({...baseEnv, QUERY_STRING: 'status=999'}).headers).toContain('Status: 200');
  });

  it('reflects the POST method, content length, and stdin body verbatim', () => {
    const {body} = run(
      {...baseEnv, REQUEST_METHOD: 'POST', MNDW_ENDPOINT_ID: 'echoPost', CONTENT_LENGTH: '8'},
      '{"hi":1}',
    );
    const parsed = JSON.parse(body);

    expect(parsed).toMatchObject({method: 'POST', endpointId: 'echoPost', contentLength: '8'});
    expect(parsed.body).toBe('{"hi":1}');
  });

  it('JSON-escapes a body with quotes/newlines and preserves a trailing newline verbatim', () => {
    const {body} = run({...baseEnv, REQUEST_METHOD: 'POST'}, 'a"b\nc\n');

    expect(JSON.parse(body).body).toBe('a"b\nc\n');
  });
});
