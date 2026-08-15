import type {PluginI18n, PluginManifestI18n} from '@mndw/sdk';
import {type PluginCatalog, parseCatalog} from '@mndw/sdk/catalog';
import {formatMessage, normalizeFormatterLocale} from '@mndw/sdk/i18n-format';

export type {PluginCatalog};
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

export interface CatalogGeneration {
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

export interface PluginCatalogDeps {
  fetchCatalog?: (url: string) => Promise<PluginCatalog>;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  queueMicrotask?: typeof globalThis.queueMicrotask;
}

interface CatalogRuntime {
  readonly catalogSuccessCache: Map<string, PluginCatalog>;
  readonly catalogCells: Set<PluginCatalogCell>;
  activeGeneration: CatalogGeneration | undefined;
  nextGenerationToken: number;
  readonly fetchCatalog: (url: string) => Promise<PluginCatalog>;
  readonly now: () => number;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly queueMicrotask: typeof globalThis.queueMicrotask;
}

function createRuntime(deps: PluginCatalogDeps = {}): CatalogRuntime {
  return {
    catalogSuccessCache: new Map<string, PluginCatalog>(),
    catalogCells: new Set<PluginCatalogCell>(),
    activeGeneration: undefined,
    nextGenerationToken: 0,
    fetchCatalog: deps.fetchCatalog ?? fetchCatalogFromNetwork,
    now: deps.now ?? Date.now,
    setTimeout: deps.setTimeout ?? globalThis.setTimeout.bind(globalThis),
    queueMicrotask: deps.queueMicrotask ?? globalThis.queueMicrotask.bind(globalThis),
  };
}

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

async function loadCatalog(
  runtime: CatalogRuntime,
  source: PluginCatalogSource,
  locale: string,
  deadline?: number,
): Promise<PluginCatalog> {
  const cached = runtime.catalogSuccessCache.get(cacheKey(source, locale));

  if (cached !== undefined) {
    return cached;
  }

  const url = catalogUrl(source, locale);

  if (url === undefined) {
    throw new Error(`Plugin "${source.name}" does not declare a catalog for ${locale}`);
  }

  try {
    const catalog = await runtime.fetchCatalog(url);

    if (deadline !== undefined && runtime.now() > deadline) {
      throw new Error('catalog request completed after deadline');
    }

    runtime.catalogSuccessCache.set(cacheKey(source, locale), catalog);

    return catalog;
  } catch (error) {
    // Rejections and timeouts intentionally never enter the success cache.
    runtime.catalogSuccessCache.delete(cacheKey(source, locale));

    throw error;
  }
}

function deadlinePromise(runtime: CatalogRuntime, deadline: number): Promise<never> {
  const remaining = Math.max(0, deadline - runtime.now());

  return new Promise((_, reject) => {
    runtime.setTimeout(() => reject(new Error('catalog deadline exceeded')), remaining);
  });
}

async function loadState(
  runtime: CatalogRuntime,
  source: PluginCatalogSource,
  targetLocale: string,
  deadline: number,
): Promise<PluginCatalogState> {
  const resolvedCatalogLocale = resolveCatalogLocale(source, targetLocale);
  const defaultLocale = source.defaultLocale;
  const primaryPromise = loadCatalog(runtime, source, resolvedCatalogLocale, deadline);
  const defaultPromise = resolvedCatalogLocale === defaultLocale
    ? primaryPromise
    : loadCatalog(runtime, source, defaultLocale, deadline);

  const settled = await Promise.race([
    Promise.allSettled([primaryPromise, defaultPromise]),
    deadlinePromise(runtime, deadline),
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

  constructor(source: PluginCatalogSource, locale: string) {
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

function createPluginCatalogCellForRuntime(
  runtime: CatalogRuntime,
  source: PluginCatalogSource,
  locale: string,
): PluginCatalogCell {
  const cell = new CatalogCell(source, locale);

  runtime.catalogCells.add(cell);

  if (runtime.activeGeneration !== undefined) {
    runtime.activeGeneration.add(cell);
  }

  return cell;
}

function registerPluginCatalogCellForRuntime(runtime: CatalogRuntime, cell: PluginCatalogCell): void {
  runtime.catalogCells.add(cell);
}

function unregisterPluginCatalogCellForRuntime(runtime: CatalogRuntime, cell: PluginCatalogCell): void {
  runtime.catalogCells.delete(cell);
}

function clearPluginCatalogCellsForRuntime(runtime: CatalogRuntime): void {
  runtime.activeGeneration?.discard();
  runtime.catalogCells.clear();
  runtime.activeGeneration = undefined;
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

async function loadInitialPluginCatalogForRuntime(
  runtime: CatalogRuntime,
  cell: PluginCatalogCell,
  activeLocale: string,
  timeoutMs = CATALOG_TIMEOUT_MS,
): Promise<void> {
  cell.commit(await loadState(runtime, cell.source, activeLocale, runtime.now() + timeoutMs));
}

class Generation implements CatalogGeneration {
  private readonly runtime: CatalogRuntime;
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

  constructor(runtime: CatalogRuntime, targetLocale: string) {
    this.runtime = runtime;
    this.token = ++runtime.nextGenerationToken;
    this.targetLocale = targetLocale;
    this.deadline = runtime.now() + CATALOG_TIMEOUT_MS;
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
    runtime.setTimeout(() => this.settle(), CATALOG_TIMEOUT_MS);
  }

  public add(cell: PluginCatalogCell): void {
    if (this.settled || this.runtime.now() >= this.deadline || this.cells.has(cell)) {
      return;
    }

    this.pending += 1;

    const statePromise = loadState(this.runtime, cell.source, this.targetLocale, this.deadline)
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

    this.runtime.queueMicrotask(() => {
      if (this.settled || !this.initialEnrollmentDone || this.pending > 0) {
        return;
      }

      this.settled = true;
      this.resolvePromise();
    });
  }

  public commit(beforeNotify: () => void): void {
    if (this.runtime.activeGeneration !== this) {
      return;
    }

    for (const [cell, state] of this.resolvedStates) {
      cell.commit(state, false);
    }

    beforeNotify();

    for (const cell of this.resolvedStates.keys()) {
      const state = this.resolvedStates.get(cell);

      if (this.runtime.activeGeneration === this && state !== undefined) {
        cell.commit(state);
      }
    }

    this.runtime.activeGeneration = undefined;
  }
}

function preparePluginCatalogGenerationForRuntime(runtime: CatalogRuntime, targetLocale: string): CatalogGeneration {
  if (runtime.activeGeneration !== undefined) {
    throw new Error('A plugin catalog generation is already pending');
  }

  const generation = new Generation(runtime, targetLocale);

  runtime.activeGeneration = generation;

  for (const cell of runtime.catalogCells) {
    generation.add(cell);
  }

  generation.closeEnrollment();

  return generation;
}

function commitPluginCatalogGenerationForRuntime(
  generation: CatalogGeneration,
  beforeNotify: () => void,
): void {
  generation.commit(beforeNotify);
}

function discardPluginCatalogGenerationForRuntime(runtime: CatalogRuntime, generation: CatalogGeneration): void {
  generation.discard();

  if (runtime.activeGeneration === generation) {
    runtime.activeGeneration = undefined;
  }
}

function getActivePluginCatalogGenerationForRuntime(runtime: CatalogRuntime): CatalogGeneration | undefined {
  return runtime.activeGeneration;
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

export interface PluginCatalogService {
  createPluginCatalogCell(source: PluginCatalogSource, locale: string): PluginCatalogCell;
  registerPluginCatalogCell(cell: PluginCatalogCell): void;
  unregisterPluginCatalogCell(cell: PluginCatalogCell): void;
  clearPluginCatalogCells(): void;
  loadInitialPluginCatalog(cell: PluginCatalogCell, activeLocale: string, timeoutMs?: number): Promise<void>;
  preparePluginCatalogGeneration(targetLocale: string): CatalogGeneration;
  commitPluginCatalogGeneration(generation: CatalogGeneration, beforeNotify: () => void): void;
  discardPluginCatalogGeneration(generation: CatalogGeneration): void;
  getActivePluginCatalogGeneration(): CatalogGeneration | undefined;
}

export function createPluginCatalogService(deps: PluginCatalogDeps = {}): PluginCatalogService {
  const runtime = createRuntime(deps);

  return {
    createPluginCatalogCell: (source, locale) => createPluginCatalogCellForRuntime(runtime, source, locale),
    registerPluginCatalogCell: (cell) => registerPluginCatalogCellForRuntime(runtime, cell),
    unregisterPluginCatalogCell: (cell) => unregisterPluginCatalogCellForRuntime(runtime, cell),
    clearPluginCatalogCells: () => clearPluginCatalogCellsForRuntime(runtime),
    loadInitialPluginCatalog: (cell, activeLocale, timeoutMs) =>
      loadInitialPluginCatalogForRuntime(runtime, cell, activeLocale, timeoutMs),
    preparePluginCatalogGeneration: (targetLocale) => preparePluginCatalogGenerationForRuntime(runtime, targetLocale),
    commitPluginCatalogGeneration: (generation, beforeNotify) =>
      commitPluginCatalogGenerationForRuntime(generation, beforeNotify),
    discardPluginCatalogGeneration: (generation) => discardPluginCatalogGenerationForRuntime(runtime, generation),
    getActivePluginCatalogGeneration: () => getActivePluginCatalogGenerationForRuntime(runtime),
  };
}

/** Production catalog runtime; isolated consumers construct one with createPluginCatalogService. */
export const pluginCatalogService = createPluginCatalogService();

export const PLUGIN_CATALOG_TIMEOUT_MS = CATALOG_TIMEOUT_MS;
