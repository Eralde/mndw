import path from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {reloadOnSentinel} from './reload-on-sentinel.js';

interface FakeServer {
  watcher: {
    add: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  ws: {send: ReturnType<typeof vi.fn>};
  emit(event: 'add' | 'change', changedPath: string): void;
}

function fakeServer(): FakeServer {
  const listeners = new Map<'add' | 'change', (changedPath: string) => void>();
  const watcher = {
    add: vi.fn(),
    on: vi.fn((event: 'add' | 'change', listener: (changedPath: string) => void) => {
      listeners.set(event, listener);
    }),
  };

  return {
    watcher,
    ws: {send: vi.fn()},
    emit: (event, changedPath) => listeners.get(event)?.(changedPath),
  };
}

function configureServer(sentinelPath: string, server: FakeServer): void {
  const hook = reloadOnSentinel(sentinelPath).configureServer;

  if (typeof hook === 'function') {
    hook(server as never);
  } else {
    hook?.handler(server as never);
  }
}

describe('reloadOnSentinel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds only the configured sentinel path to the watcher', () => {
    const sentinelPath = path.resolve('/repo/.dev-data/mndw-dev-reload/session-one/sentinel');
    const server = fakeServer();

    configureServer(sentinelPath, server);

    expect(server.watcher.add).toHaveBeenCalledWith(sentinelPath);
    expect(server.watcher.add).toHaveBeenCalledTimes(1);
  });

  it('sends one full reload for a sentinel change', async () => {
    vi.useFakeTimers();
    const sentinelPath = path.resolve('/repo/.dev-data/mndw-dev-reload/session-one/sentinel');
    const server = fakeServer();

    configureServer(sentinelPath, server);
    server.emit('change', sentinelPath);
    await vi.advanceTimersByTimeAsync(50);

    expect(server.ws.send).toHaveBeenCalledWith({type: 'full-reload'});
    expect(server.ws.send).toHaveBeenCalledTimes(1);
  });

  it('accepts sentinel add events as a safety net', async () => {
    vi.useFakeTimers();
    const sentinelPath = path.resolve('/repo/.dev-data/mndw-dev-reload/session-one/sentinel');
    const server = fakeServer();

    configureServer(sentinelPath, server);
    server.emit('add', sentinelPath);
    await vi.advanceTimersByTimeAsync(50);

    expect(server.ws.send).toHaveBeenCalledWith({type: 'full-reload'});
  });

  it('ignores changes for every other path', async () => {
    vi.useFakeTimers();
    const sentinelPath = path.resolve('/repo/.dev-data/mndw-dev-reload/session-one/sentinel');
    const server = fakeServer();

    configureServer(sentinelPath, server);
    server.emit('change', path.resolve('/repo/src/index.ts'));
    await vi.advanceTimersByTimeAsync(50);

    expect(server.ws.send).not.toHaveBeenCalled();
  });

  it('coalesces rapid sentinel events', async () => {
    vi.useFakeTimers();
    const sentinelPath = path.resolve('/repo/.dev-data/mndw-dev-reload/session-one/sentinel');
    const server = fakeServer();

    configureServer(sentinelPath, server);
    server.emit('change', sentinelPath);
    server.emit('change', sentinelPath);
    await vi.advanceTimersByTimeAsync(49);
    expect(server.ws.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(server.ws.send).toHaveBeenCalledTimes(1);
  });
});
