// @vitest-environment happy-dom
import {NEVER, Observable, Subject, of, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RCI_HEARTBEAT_INTERVAL_MS, RciService} from './rci.service.js';

const services: RciService[] = [];

function createService(): RciService {
  const service = new RciService();

  vi.spyOn(service.auth, 'logout').mockReturnValue(of({}));
  services.push(service);

  return service;
}

function mockQueue(service: RciService, response: Observable<unknown> = of({})) {
  const queue = vi.spyOn(service.driver, 'queue');

  queue.mockReturnValue(response as never);

  return queue;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const service of services) {
    service.logout().subscribe();
  }

  services.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RciService heartbeat', () => {
  it('sends show.system immediately and periodically after an authenticated check', async () => {
    const service = createService();
    const queue = mockQueue(service);

    vi.spyOn(service.auth, 'isAuthenticated').mockReturnValue(of(true));

    service.isAuthenticated().subscribe();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RCI_HEARTBEAT_INTERVAL_MS);

    expect(queue).toHaveBeenNthCalledWith(1, {path: 'show.system'});
    expect(queue).toHaveBeenNthCalledWith(2, {path: 'show.system'});
  });

  it('starts heartbeat after a successful login', async () => {
    const service = createService();
    const queue = mockQueue(service);

    vi.spyOn(service.auth, 'login').mockReturnValue(of(true));

    service.login('user', 'password').subscribe();
    await vi.advanceTimersByTimeAsync(0);

    expect(queue).toHaveBeenCalledWith({path: 'show.system'});
  });

  it('continues polling after a failed heartbeat request', async () => {
    const service = createService();
    const queue = mockQueue(service);

    queue
      .mockReturnValueOnce(throwError(() => new Error('temporary failure')))
      .mockReturnValue(of({}));

    vi.spyOn(service.auth, 'isAuthenticated').mockReturnValue(of(true));

    service.isAuthenticated().subscribe();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RCI_HEARTBEAT_INTERVAL_MS);

    expect(queue).toHaveBeenCalledTimes(2);
  });

  it('does not overlap heartbeat requests', async () => {
    const service = createService();
    const pending = new Subject<unknown>();
    const queue = mockQueue(service, pending);

    vi.spyOn(service.auth, 'isAuthenticated').mockReturnValue(of(true));

    service.isAuthenticated().subscribe();
    await vi.advanceTimersByTimeAsync(RCI_HEARTBEAT_INTERVAL_MS * 2);

    expect(queue).toHaveBeenCalledTimes(1);

    pending.complete();
    await vi.advanceTimersByTimeAsync(RCI_HEARTBEAT_INTERVAL_MS);

    expect(queue).toHaveBeenCalledTimes(2);
  });
});

describe('RciService authentication lifecycle', () => {
  it('stops heartbeat when logging out', async () => {
    const service = createService();
    const queue = mockQueue(service);

    vi.spyOn(service.auth, 'isAuthenticated').mockReturnValue(of(true));

    service.isAuthenticated().subscribe();
    await vi.advanceTimersByTimeAsync(0);
    service.logout().subscribe();
    await vi.advanceTimersByTimeAsync(RCI_HEARTBEAT_INTERVAL_MS * 2);

    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('does not start heartbeat when authentication check is false', async () => {
    const service = createService();
    const queue = mockQueue(service, NEVER);

    vi.spyOn(service.auth, 'isAuthenticated').mockReturnValue(of(false));

    service.isAuthenticated().subscribe();
    await vi.advanceTimersByTimeAsync(RCI_HEARTBEAT_INTERVAL_MS);

    expect(queue).not.toHaveBeenCalled();
  });
});
