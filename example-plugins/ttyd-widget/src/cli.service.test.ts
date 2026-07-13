import {afterEach, describe, expect, it, vi} from 'vitest';
import {killCli, spawnCli} from './cli.service';

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

describe('cli.service', () => {
  it('spawnCli returns success + port', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({success: true, port: 7681}));

    const result = await spawnCli('/api/plugins/ttyd-widget/spawn');

    expect(result).toEqual({success: true, port: 7681});
  });

  it('spawnCli maps "ttyd is not installed" to a spawn failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({success: false, error: 'ttyd is not installed'}));

    const result = await spawnCli('/api/plugins/ttyd-widget/spawn');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('SPAWN_FAILED');
    expect(result.error).toMatch(/not installed/i);
  });

  it('killCli returns the parsed success flag', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({success: true}));

    expect(await killCli('/api/plugins/ttyd-widget/kill')).toEqual({success: true});
  });
});
