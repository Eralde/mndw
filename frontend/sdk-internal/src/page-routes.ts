export const RESERVED_PAGE_ROUTES = ['/', '/login', '/packages', '/packages/services', '/settings'] as const;

const reservedPageRouteSet = new Set<string>(RESERVED_PAGE_ROUTES);

export function isReservedPageRoute(route: string): boolean {
  return reservedPageRouteSet.has(route);
}
