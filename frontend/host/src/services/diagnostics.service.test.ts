import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  type DiagnosticsDependencies,
  type RequestFn,
  downloadDiagnostics,
  formatDiagnosticsReport,
} from './diagnostics.service.js';

const NOW = new Date('2026-08-04T15:30:00.000Z');

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function dependencies(request: RequestFn): DiagnosticsDependencies & {
  request: ReturnType<typeof vi.fn<RequestFn>>;
  createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
  revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
  anchor: HTMLAnchorElement;
  click: ReturnType<typeof vi.fn<() => void>>;
} {
  const anchor = document.createElement('a');
  const click = vi.spyOn(anchor, 'click') as unknown as ReturnType<typeof vi.fn<() => void>>;
  const createObjectURL = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:diagnostics');
  const revokeObjectURL = vi.fn<(url: string) => void>();

  return {
    request: request as ReturnType<typeof vi.fn<RequestFn>>,
    now: () => NOW,
    browser: {
      createObjectURL,
      revokeObjectURL,
      createAnchor: () => anchor,
      appendAnchor: vi.fn(),
      removeAnchor: vi.fn(),
    },
    createObjectURL,
    revokeObjectURL,
    anchor,
    click,
  };
}

describe('diagnostics service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('collects labeled sections in the required order with CSRF headers', async () => {
    const request = vi.fn<RequestFn>();

    request.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.endsWith('/api/mndw/diagnostics/export')) {
        return Promise.resolve(response({
          generatedAt: '2026-08-04T15:29:00Z',
          mndwd: {logTail: 'ready'},
          plugins: [
            {pluginId: 'alpha', generatedAt: '2026-08-04T15:28:00Z', data: {status: 'ready', cpuRrd: {data: [{v: 1}]}},
              errors: []},
            {pluginId: 'beta', filePresent: false, errors: ['missing diagnostics file']},
          ],
        }));
      }

      if (url.endsWith('/api/mndw/rci-session/capability')) {
        return Promise.resolve(response({controller: {support: 'supported'}}));
      }

      throw new Error(`unexpected endpoint: ${url}`);
    });

    const deps = dependencies(request);

    await downloadDiagnostics(deps);

    expect(request).toHaveBeenCalledTimes(2);

    expect(request.mock.calls[0]?.[1]).toEqual({method: 'POST', headers: {'X-Mndw-Csrf': '1'}});
    expect(request.mock.calls[1]?.[1]).toEqual({headers: {'X-Mndw-Csrf': '1'}});

    const url = deps.createObjectURL.mock.calls[0]?.[0];
    const report = await url?.text();

    expect(report).toContain('mndwd diagnostics');
    expect(report).toContain('persistent rci-session capability');
    expect(report).not.toContain('mwsd nodes');
    expect(report?.indexOf('mndwd diagnostics')).toBeLessThan(
      report?.indexOf('persistent rci-session capability') ?? 0,
    );
    expect(report).toContain('alpha');
    expect(report).toContain('beta');
    expect(report).toContain('cpuRrd');
    expect(report).toContain('missing diagnostics file');
  });

  it('keeps other sections when one endpoint fails', async () => {
    const request = vi.fn<RequestFn>();

    request.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.endsWith('/api/mndw/rci-session/capability')) {
        throw new Error('connection refused');
      }

      if (url.endsWith('/api/mndw/diagnostics/export')) {
        return Promise.resolve(response({plugins: [{pluginId: 'alpha', data: {status: 'ready'}, errors: []}]}));
      }

      throw new Error(`unexpected endpoint: ${url}`);
    });

    const deps = dependencies(request);

    await downloadDiagnostics(deps);

    const report = await deps.createObjectURL.mock.calls[0]?.[0].text();

    expect(report).toContain('persistent rci-session capability');
    expect(report).toContain('request failed: connection refused');
    expect(report).toContain('alpha');
    expect(report).not.toContain('mwsd nodes');
  });

  it('redacts secret values while preserving diagnostic fields', () => {
    const report = formatDiagnosticsReport([
      {
        title: 'diagnostics',
        value: {
          password: 'DO_NOT_EXPORT',
          token: 'DO_NOT_EXPORT',
          credState: 'absent',
          status: 'ready',
          path: '/tmp/mwsd',
        },
      },
    ], NOW);

    expect(report).not.toContain('DO_NOT_EXPORT');
    expect(report).toContain('"credState": "absent"');
    expect(report).toContain('"status": "ready"');
    expect(report).toContain('/tmp/mwsd');
  });

  it('uses a timestamped text download and revokes its object URL', async () => {
    const request = vi.fn<RequestFn>().mockResolvedValue(response({ready: true}));
    const deps = dependencies(request);

    await downloadDiagnostics(deps);

    expect(deps.createObjectURL).toHaveBeenCalledTimes(1);
    expect(deps.anchor.download).toBe('mndw-diagnostics-20260804-153000.txt');
    expect(deps.click).toHaveBeenCalledTimes(1);
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostics');

    const blob = deps.createObjectURL.mock.calls[0]?.[0];

    expect(blob?.type).toBe('text/plain;charset=utf-8');
  });
});
