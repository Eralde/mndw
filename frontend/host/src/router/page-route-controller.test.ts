import {PageRouteError} from '@mndw/sdk';
import {BehaviorSubject} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {PageRouteController, type PageRouteControllerDeps} from './page-route-controller.js';

function createController(
  initialChildPath = '',
  overrides: Partial<PageRouteControllerDeps> = {},
): {controller: PageRouteController; deps: PageRouteControllerDeps} {
  const deps: PageRouteControllerDeps = {
    navigate: vi.fn(() => Promise.resolve(undefined)),
    getLocation: vi.fn(() => ({search: '?mode=large', hash: '#node-7'})),
    ...overrides,
  };

  return {controller: new PageRouteController('/mws', initialChildPath, deps), deps};
}

describe('PageRouteController', () => {
  it('emits current child path immediately, normalizes host updates, deduplicates, and completes', () => {
    const {controller} = createController();
    const seen: string[] = [];
    let completed = false;

    controller.pageRoute.childPath$.subscribe({
      next: (path) => seen.push(path),
      complete: () => {
        completed = true;
      },
    });

    controller.setPath('/clients/');
    controller.setPath('/clients');
    controller.setPath('/clients//');
    controller.complete();
    controller.setPath('/topology');

    expect(seen).toEqual(['', '/clients', '/clients/']);
    expect(completed).toBe(true);

    const lateSeen: string[] = [];
    let lateCompleted = false;

    controller.pageRoute.childPath$.subscribe({
      next: (path) => lateSeen.push(path),
      complete: () => {
        lateCompleted = true;
      },
    });

    expect(lateSeen).toEqual([]);
    expect(lateCompleted).toBe(true);
  });

  it.each([
    '/a//b',
    '//a',
    '/a?query',
    '/a#hash',
    'https://example.test/a',
    '/a\\b',
    '/.',
    '/..',
    '/a/.',
    '/a/..',
    '/%2e',
    '/%2e%2e',
    '/a/%2F',
    '/a/%5C',
    '/a/%',
    '/a/%2',
    '/a/%GG',
  ])('rejects invalid child path %s with INVALID_PATH', async (childPath) => {
    const {controller, deps} = createController();
    const navigate = vi.mocked(deps.navigate);

    await expect(controller.pageRoute.navigate(childPath)).rejects.toMatchObject({
      code: 'INVALID_PATH',
      name: 'PageRouteError',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('preserves valid percent encoding and forwards raw location pieces', async () => {
    const {controller, deps} = createController();
    const navigate = vi.mocked(deps.navigate);

    await controller.pageRoute.navigate('/clients%20archive', {replace: true});

    expect(navigate).toHaveBeenCalledWith('/mws/clients%20archive', {
      replace: true,
      search: '?mode=large',
      hash: '#node-7',
      scrollToTop: 'auto',
    });
  });

  it('maps scrollToTop false to the router seam and defaults replacement to push', async () => {
    const {controller, deps} = createController();
    const navigate = vi.mocked(deps.navigate);

    await controller.pageRoute.navigate('/clients', {scrollToTop: false});

    expect(navigate).toHaveBeenCalledWith('/mws/clients', {
      replace: false,
      search: '?mode=large',
      hash: '#node-7',
      scrollToTop: false,
    });
  });

  it('does not navigate or scroll for normalized no-op paths', async () => {
    const {controller, deps} = createController('/clients');
    const navigate = vi.mocked(deps.navigate);

    await controller.pageRoute.navigate('/clients/');

    expect(navigate).not.toHaveBeenCalled();
  });

  it('maps router rejection to NAVIGATION_FAILED while preserving cause', async () => {
    const cause = new Error('router failed');
    const {controller} = createController('', {
      navigate: vi.fn(() => Promise.reject(cause)),
    });

    const error = await controller.pageRoute.navigate('/clients').catch((value: unknown) => value);

    expect(error).toBeInstanceOf(PageRouteError);
    expect(error).toMatchObject({code: 'NAVIGATION_FAILED', name: 'PageRouteError', cause});
  });

  it('rejects future calls after completion and does not emit navigation results after teardown', async () => {
    let resolveNavigation: (() => void) | undefined;
    const {controller, deps} = createController('', {
      navigate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveNavigation = resolve;
          }),
      ),
    });
    const navigate = vi.mocked(deps.navigate);
    const seen: string[] = [];

    controller.pageRoute.childPath$.subscribe((path) => seen.push(path));

    const pending = controller.pageRoute.navigate('/clients');

    controller.complete();

    await expect(controller.pageRoute.navigate('/topology')).rejects.toMatchObject({code: 'COMPLETED'});
    resolveNavigation?.();
    await pending;

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['']);
  });

  it('starts concurrent navigations immediately and lets the later result win', async () => {
    const pending: Array<() => void> = [];
    const {controller, deps} = createController('', {
      navigate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            pending.push(resolve);
          }),
      ),
    });
    const navigate = vi.mocked(deps.navigate);
    const seen: string[] = [];

    controller.pageRoute.childPath$.subscribe((path) => seen.push(path));

    const first = controller.pageRoute.navigate('/first');
    const second = controller.pageRoute.navigate('/second');

    expect(navigate).toHaveBeenCalledTimes(2);
    pending[1]?.();
    await second;
    pending[0]?.();
    await first;

    expect(seen).toEqual(['', '/second']);
  });

  it('exposes an Observable rather than its mutable subject', () => {
    const {controller} = createController();

    expect(controller.pageRoute.childPath$).not.toBeInstanceOf(BehaviorSubject);
  });
});
