import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../backend/main.sh');

describe('hello backend command', () => {
  it('emits a CGI header block and the greeting JSON', () => {
    const result = spawnSync('sh', [SCRIPT], {encoding: 'utf8'});

    if (result.error) {
      throw result.error;
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Content-Type: application/json\r\n\r\n{"message":"hello from hello-widget"}\n');

    const separator = result.stdout.indexOf('\r\n\r\n');

    expect(separator).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(result.stdout.slice(separator + 4))).toEqual({message: 'hello from hello-widget'});
  });
});
