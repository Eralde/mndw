// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {RESERVED_PAGE_ROUTES} from '@mndw/sdk-internal';
import type {RouteComponent} from 'sv-router';
import {buildHostRouteTable} from './create-app-router.js';
import {HOST_PATHS} from './host-routes.js';

describe('host routes', () => {
  it('reserves every top-level host path for page plugins', () => {
    const topLevelPaths: string[] = [];

    for (const path of Object.values(HOST_PATHS)) {
      if (typeof path === 'string') {
        topLevelPaths.push(path);
      }
    }

    const reservedPaths = new Set<string>(RESERVED_PAGE_ROUTES);

    expect(topLevelPaths.every((path) => reservedPaths.has(path))).toBe(true);
  });

  it('uses exactly host paths, plugin routes, and wildcard in the router table', () => {
    const pagePlugin = {} as unknown as RouteComponent;
    const pluginRoutes = {
      '/mws': pagePlugin,
      '/mws/*child': pagePlugin,
    };
    const routes = buildHostRouteTable(pluginRoutes);
    const expectedHostPaths = Object.values(HOST_PATHS).flatMap((path) => {
      if (typeof path === 'string') {
        return [path];
      }

      return Object.values(path);
    });

    expect(Object.keys(routes).sort()).toEqual([
      ...expectedHostPaths,
      ...Object.keys(pluginRoutes),
      '*',
    ].sort());
  });
});
