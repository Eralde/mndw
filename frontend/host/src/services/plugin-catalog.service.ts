import type {PluginI18n, PluginManifestI18n} from '@mndw/sdk';
import {type PluginCatalog, parseCatalog} from '@mndw/sdk/catalog';
import {formatMessage, normalizeFormatterLocale} from '@mndw/sdk/i18n-format';

export type { PluginCatalog };
export type PluginCatalogFallbackStatus = 'primary' | 'default' | 'key';

export interface PluginCatalogSource {
  name: string;
  version: string;
  baseUrl: string;
  defaultLocale: string;
  locales: Record<string, string>;
}

export interface PluginCatalogState {
  hostLocale: string;
  resolvedCatalogLocale: string;
  primaryCatalog?: PluginCatalog;
  defaultCatalog?: PluginCatalog;
  fallbackStatus: PluginCatalogFallbackStatus;
}

export interface PluginCatalogCell {
  readonly source: PluginCatalogSource;
  readCurrentState(): PluginCatalogState;
  subscribe(callback: () => void): () => void;
  commit(state: PluginCatalogState, notify?: boolean): void;
}

interface CatalogGeneration {
  readonly token: number;
  readonly targetLocale: string;
  readonly deadline: number;
  readonly promise: Promise<void>;
  add(cell: PluginCatalogCell): void;
  closeEnrollment(): void;
  discard(): void;
  commit(beforeNotify: () => void): void;
}

const CATALOG_TIMEOUT_MS = 3000;
const catalogSuccessCache = new Map<string, PluginCatalog>();
const catalogCells = new Set<PluginCatalogCell>();
let activeGeneration: CatalogGeneration | undefined;
let nextGenerationToken = 0;
let fetchCatalog: (url: string) => Promise<PluginCatalog> = fetchCatalogFromNetwork;

function cacheKey(source: PluginCatalogSource, locale: string): string {
  return `${source.name}/${source.version}/${locale}`;
}

function catalogUrl(source: PluginCatalogSource, locale: string): string | undefined {
  const path = source.locales[locale];

  if (path === undefined) {
    return undefined;
  }

  return `${source.baseUrl.replace(/\/$/, '')}/${path}?v=${encodeURIComponent(source.version)}`;
}

function languageOnly(locale: string): string | undefined {
  return locale.split('-')[0];
}

function resolveCatalogLocale(source: PluginCatalogSource, targetLocale: string): string {
  if (source.locales[targetLocale] !== undefined) {
    return targetLocale;
  }

  const language = languageOnly(targetLocale);

  if (language !== undefined && source.locales[language] !== undefined) {
    return language;
  }

  return source.defaultLocale;
}

async function fetchCatalogFromNetwork(url: string): Promise<PluginCatalog> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return parseCatalog(await response.json(), url);
}

async function loadCatalog(source: PluginCatalogSource, locale: string, deadline?: number): Promise<PluginCatalog> {
  const cached = catalogSuccessCache.get(cacheKey(source, locale));

  if (cached !== undefined) {
    return cached;
  }

  const url = catalogUrl(source, locale);

  if (url === undefined) {
    throw new Error(`Plugin "${source.name}" does not declare a catalog for ${locale}`);
  }

  try {
    const catalog = await fetchCatalog(url);

    if (deadline !== undefined && Date.now() > deadline) {
      throw new Error('catalog request completed after deadline');
    }

    catalogSuccessCache.set(cacheKey(source, locale), catalog);

    return catalog;
  } catch (error) {
    // Rejections and timeouts intentionally never enter the success cache.
    catalogSuccessCache.delete(cacheKey(source, locale));

    throw error;
  }
}

function deadlinePromise(deadline: number): Promise<never> {
  const remaining = Math.max(0, deadline - Date.now());

  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('catalog deadline exceeded')), remaining);
  });
}

async function loadState(
  source: PluginCatalogSource,
  targetLocale: string,
  deadline: number,
): Promise<PluginCatalogState> {
  const resolvedCatalogLocale = resolveCatalogLocale(source, targetLocale);
  const defaultLocale = source.defaultLocale;
  const primaryPromise = loadCatalog(source, resolvedCatalogLocale, deadline);
  const defaultPromise = resolvedCatalogLocale === defaultLocale
    ? primaryPromise
    : loadCatalog(source, defaultLocale, deadline);

  const settled = await Promise.race([
    Promise.allSettled([primaryPromise, defaultPromise]),
    deadlinePromise(deadline),
  ]).catch(() => undefined);

  const primary = Array.isArray(settled) && settled[0]?.status === 'fulfilled'
    ? settled[0].value
    : undefined;
  const defaultCatalog = Array.isArray(settled) && settled[1]?.status === 'fulfilled'
    ? settled[1].value
    : undefined;

  return {
    hostLocale: targetLocale,
    resolvedCatalogLocale,
    ...(primary === undefined ? {} : {primaryCatalog: primary}),
    ...(defaultCatalog === undefined ? {} : {defaultCatalog}),
    fallbackStatus: primary !== undefined ? 'primary' : defaultCatalog !== undefined ? 'default' : 'key',
  };
}

function emptyState(source: PluginCatalogSource, locale: string): PluginCatalogState {
  return {
    hostLocale: locale,
    resolvedCatalogLocale: resolveCatalogLocale(source, locale),
    fallbackStatus: 'key',
  };
}

class CatalogCell implements PluginCatalogCell {
  public readonly source: PluginCatalogSource;
  private state: PluginCatalogState;
  private listeners = new Set<() => void>();

  public constructor(source: PluginCatalogSource, locale: string) {
    this.source = Object.freeze({...source, locales: Object.freeze({...source.locales})});
    this.state = emptyState(this.source, locale);
  }

  public readCurrentState(): PluginCatalogState {
    return this.state;
  }

  public subscribe(callback: () => void): () => void {
    this.listeners.add(callback);

    return () => {
      this.listeners.delete(callback);
    };
  }

  public commit(state: PluginCatalogState, notify = true): void {
    this.state = Object.freeze(state);

    if (notify) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }
}

export function createPluginCatalogCell(source: PluginCatalogSource, locale: string): PluginCatalogCell {
  const cell = new CatalogCell(source, locale);
  catalogCells.add(cell);

  if (activeGeneration !== undefined) {
    activeGeneration.add(cell);
  }

  return cell;
}

export function registerPluginCatalogCell(cell: PluginCatalogCell): void {
  catalogCells.add(cell);
}

export function unregisterPluginCatalogCell(cell: PluginCatalogCell): void {
  catalogCells.delete(cell);
}

export function clearPluginCatalogCells(): void {
  activeGeneration?.discard();
  catalogCells.clear();
  activeGeneration = undefined;
}

export function createPluginCatalogSource(
  name: string,
  version: string,
  baseUrl: string,
  i18n: PluginManifestI18n | undefined,
): PluginCatalogSource | undefined {
  if (i18n === undefined) {
    return undefined;
  }

  return {name, version, baseUrl, defaultLocale: i18n.defaultLocale, locales: i18n.locales};
}

export async function loadInitialPluginCatalog(
  cell: PluginCatalogCell,
  activeLocale: string,
  timeoutMs = CATALOG_TIMEOUT_MS,
): Promise<void> {
  cell.commit(await loadState(cell.source, activeLocale, Date.now() + timeoutMs));
}

class Generation implements CatalogGeneration {
  public readonly token: number;
  public readonly targetLocale: string;
  public readonly deadline: number;
  public readonly promise: Promise<void>;
  private pending = 0;
  private initialEnrollmentDone = false;
  private settled = false;
  private cells = new Map<PluginCatalogCell, Promise<PluginCatalogState>>();
  private resolvedStates = new Map<PluginCatalogCell, PluginCatalogState>();
  private resolvePromise!: () => void;

  public constructor(targetLocale: string) {
    this.token = ++nextGenerationToken;
    this.targetLocale = targetLocale;
    this.deadline = Date.now() + CATALOG_TIMEOUT_MS;
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
    setTimeout(() => this.settle(), CATALOG_TIMEOUT_MS);
  }

  public add(cell: PluginCatalogCell): void {
    if (this.settled || Date.now() >= this.deadline || this.cells.has(cell)) {
      return;
    }

    this.pending += 1;
    const statePromise = loadState(cell.source, this.targetLocale, this.deadline)
      .catch(() => emptyState(cell.source, this.targetLocale));
    this.cells.set(cell, statePromise);
    void statePromise.then((state) => {
      this.resolvedStates.set(cell, state);
    }).finally(() => {
      this.pending -= 1;
      this.settle();
    });
  }

  public closeEnrollment(): void {
    this.initialEnrollmentDone = true;
    this.settle();
  }

  public discard(): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.resolvePromise();
  }

  private settle(): void {
    if (this.settled || !this.initialEnrollmentDone || this.pending > 0) {
      return;
    }

    queueMicrotask(() => {
      if (this.settled || !this.initialEnrollmentDone || this.pending > 0) {
        return;
      }

      this.settled = true;
      this.resolvePromise();
    });
  }

  public commit(beforeNotify: () => void): void {
    if (activeGeneration !== this) {
      return;
    }

    for (const [cell, state] of this.resolvedStates) {
      cell.commit(state, false);
    }

    beforeNotify();

    for (const cell of this.resolvedStates.keys()) {
      const state = this.resolvedStates.get(cell);

      if (activeGeneration === this && state !== undefined) {
        cell.commit(state);
      }
    }

    activeGeneration = undefined;
  }
}

export function preparePluginCatalogGeneration(targetLocale: string): CatalogGeneration {
  if (activeGeneration !== undefined) {
    throw new Error('A plugin catalog generation is already pending');
  }

  const generation = new Generation(targetLocale);

  activeGeneration = generation;

  for (const cell of catalogCells) {
    generation.add(cell);
  }

  generation.closeEnrollment();

  return generation;
}

export function commitPluginCatalogGeneration(generation: CatalogGeneration, beforeNotify: () => void): void {
  generation.commit(beforeNotify);
}

export function discardPluginCatalogGeneration(generation: CatalogGeneration): void {
  generation.discard();

  if (activeGeneration === generation) {
    activeGeneration = undefined;
  }
}

export function getActivePluginCatalogGeneration(): CatalogGeneration | undefined {
  return activeGeneration;
}

export function formatPluginTranslation(
  cell: PluginCatalogCell | undefined,
  key: string,
  values: Record<string, unknown> | undefined,
  locale: string,
): string {
  const state = cell?.readCurrentState();
  const message = state?.primaryCatalog?.[key] ?? state?.defaultCatalog?.[key] ?? key;

  return formatMessage(message, values, locale);
}

export function createPluginI18n(
  cell: PluginCatalogCell | undefined,
  getHostLocale: () => string,
  subscribeHostLocale: (callback: () => void) => () => void,
): PluginI18n {
  const facade: PluginI18n = {
    get locale(): string {
      return getHostLocale();
    },
    direction: 'ltr',
    t: (key, values) => formatPluginTranslation(cell, key, values, getHostLocale()),
    formatNumber: (value, options) =>
      new Intl.NumberFormat(normalizeFormatterLocale(getHostLocale()), options).format(value),
    formatDate: (value, options) =>
      new Intl.DateTimeFormat(normalizeFormatterLocale(getHostLocale()), options).format(value),
    onChange: (callback) => {
      return cell?.subscribe(callback) ?? subscribeHostLocale(callback);
    },
  };

  return Object.freeze(facade);
}

export function setPluginCatalogFetchForTests(fetcher: (url: string) => Promise<PluginCatalog>): void {
  fetchCatalog = fetcher;
}

export function resetPluginCatalogServiceForTests(): void {
  catalogSuccessCache.clear();
  catalogCells.clear();
  activeGeneration = undefined;
  fetchCatalog = fetchCatalogFromNetwork;
  nextGenerationToken = 0;
}

export const PLUGIN_CATALOG_TIMEOUT_MS = CATALOG_TIMEOUT_MS;
