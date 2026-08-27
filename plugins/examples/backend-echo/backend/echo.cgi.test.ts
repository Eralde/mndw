import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const SCRIPT = resolve(import.meta.dirname, 'echo.cgi');

function run(body: string): Record<string, unknown> {
  const result = spawnSync('sh', [SCRIPT], {
    encoding: 'utf8',
    input: body,
    env: {
      ...process.env,
      QUERY_STRING: 'quote="&line=first\\second',
      CONTENT_TYPE: 'text/plain; note=tab\tcr\r',
    },
  });

  if (result.error) {
    throw result.error;
  }

  expect(result.status).toBe(0);

  const separator = result.stdout.indexOf('\r\n\r\n');

  expect(separator).toBeGreaterThanOrEqual(0);

  return JSON.parse(result.stdout.slice(separator + 4).trim()) as Record<string, unknown>;
}

describe('echo.cgi', () => {
  it('escapes JSON string controls without changing their decoded values', () => {
    const input = 'backslash=\\ quote=" tab=\t carriage=\r\nsecond line';
    const body = run(input);

    expect(body.query).toBe('quote="&line=first\\second');
    expect(body.contentType).toBe('text/plain; note=tab\tcr\r');
    expect(body.body).toBe(input);
  });
});
