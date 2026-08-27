import {type PageRoute, PageRouteError} from '@mndw/sdk';
import {BehaviorSubject} from 'rxjs';

export interface PageRouteControllerDeps {
  navigate: (
    pathname: string,
    options: {
      replace: boolean;
      search: string;
      hash: string;
      scrollToTop: 'auto' | false;
    },
  ) => Promise<unknown>;
  getLocation: () => {search: string; hash: string};
}

interface PageRouteOptions {
  replace?: boolean;
  scrollToTop?: boolean;
}

function normalizeHostChildPath(childPath: string): string {
  if (childPath === '/') {
    return '';
  }

  return childPath.length > 1 && childPath.endsWith('/') ? childPath.slice(0, -1) : childPath;
}

function invalidPath(childPath: string, cause?: unknown): PageRouteError {
  return new PageRouteError('INVALID_PATH', `Invalid page child path "${childPath}"`, {cause});
}

function validateChildPath(childPath: string): string {
  if (childPath === '' || childPath === '/') {
    return '';
  }

  if (!childPath.startsWith('/') || childPath.startsWith('//') || childPath.includes('?') || childPath.includes('#')) {
    throw invalidPath(childPath);
  }

  const normalizedPath = normalizeHostChildPath(childPath);

  if (normalizedPath === '') {
    return '';
  }

  const segments = normalizedPath.slice(1).split('/');
  const lastSegmentIndex = segments.length - 1;

  for (const [index, segment] of segments.entries()) {
    if (segment === '') {
      if (index !== lastSegmentIndex) {
        throw invalidPath(childPath);
      }

      continue;
    }

    let decodedSegment: string;

    try {
      decodedSegment = decodeURIComponent(segment);
    } catch (error) {
      throw invalidPath(childPath, error);
    }

    if (
      decodedSegment === '.'
      || decodedSegment === '..'
      || decodedSegment.includes('/')
      || decodedSegment.includes('\\')
    ) {
      throw invalidPath(childPath);
    }
  }

  return normalizedPath;
}

export class PageRouteController {
  private readonly baseRoute: string;
  private readonly deps: PageRouteControllerDeps;
  private readonly childPathSubject: BehaviorSubject<string>;
  private currentChildPath: string;
  private completed = false;
  private navigationSerial = 0;
  public readonly pageRoute: PageRoute;

  constructor(baseRoute: string, initialChildPath: string, deps: PageRouteControllerDeps) {
    this.baseRoute = baseRoute;
    this.deps = deps;
    this.currentChildPath = normalizeHostChildPath(initialChildPath);
    this.childPathSubject = new BehaviorSubject(this.currentChildPath);
    this.pageRoute = Object.freeze({
      childPath$: this.childPathSubject.asObservable(),
      navigate: (childPath: string, options?: PageRouteOptions): Promise<void> => this.navigate(childPath, options),
    });
  }

  public setPath(childPath: string): void {
    if (this.completed) {
      return;
    }

    const normalizedPath = normalizeHostChildPath(childPath);

    if (normalizedPath === this.currentChildPath) {
      return;
    }

    this.currentChildPath = normalizedPath;
    this.childPathSubject.next(normalizedPath);
  }

  public complete(): void {
    if (this.completed) {
      return;
    }

    this.completed = true;
    this.childPathSubject.complete();
  }

  public async navigate(childPath: string, options?: PageRouteOptions): Promise<void> {
    if (this.completed) {
      throw new PageRouteError('COMPLETED', 'Page route is no longer active');
    }

    const normalizedPath = validateChildPath(childPath);

    if (normalizedPath === this.currentChildPath) {
      return;
    }

    const requestSerial = ++this.navigationSerial;
    const location = this.deps.getLocation();

    try {
      await this.deps.navigate(`${this.baseRoute}${normalizedPath}`, {
        replace: options?.replace ?? false,
        search: location.search,
        hash: location.hash,
        scrollToTop: options?.scrollToTop === false ? false : 'auto',
      });
    } catch (cause) {
      throw new PageRouteError('NAVIGATION_FAILED', `Navigation to "${normalizedPath}" failed`, {cause});
    }

    if (!this.completed && requestSerial === this.navigationSerial) {
      this.setPath(normalizedPath);
    }
  }
}
