import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const backendDir = dirname(fileURLToPath(import.meta.url));

describe('spawn_ttyd.sh (dev path)', () => {
  it('reports ttyd not installed and exits 0 when binaries are absent', () => {
    const res = spawnSync('sh', [join(backendDir, 'spawn_ttyd.sh')], {encoding: 'utf8'});

    expect(res.status).toBe(0);

    const body = res.stdout.split(/\r?\n\r?\n/).slice(1)
      .join('\n')
      .trim();
    const parsed = JSON.parse(body) as {success: boolean; error?: string};

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/not installed/i);
  });
});
