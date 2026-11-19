import type {MndwThemeName} from '@mndw/sdk';
import {STORAGE_PREFIX} from '../constants.js';

const THEME_STORAGE_KEY = `${STORAGE_PREFIX}:theme`;
const DEFAULT_THEME: MndwThemeName = 'dark';

type ThemeListener = (theme: MndwThemeName) => void;

export interface ThemeService {
  initTheme(): MndwThemeName;
  getTheme(): MndwThemeName;
  setTheme(theme: MndwThemeName): void;
  toggleTheme(): void;
  subscribeTheme(callback: ThemeListener): () => void;
}

export interface ThemeServiceDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  document?: Document;
}

export function createThemeService(deps: ThemeServiceDeps = {}): ThemeService {
  const hostDocument = deps.document ?? globalThis.document;
  let current: MndwThemeName = DEFAULT_THEME;
  const listeners = new Set<ThemeListener>();

  function readStored(): MndwThemeName {
    try {
      const value = (deps.storage ?? globalThis.localStorage).getItem(THEME_STORAGE_KEY);

      return value === 'light' || value === 'dark' ? value : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  }

  function applyDataset(theme: MndwThemeName): void {
    hostDocument.documentElement.dataset.theme = theme;
  }

  function notify(theme: MndwThemeName): void {
    for (const listener of listeners) {
      listener(theme);
    }
  }

  function initTheme(): MndwThemeName {
    current = readStored();
    applyDataset(current);
    notify(current);

    return current;
  }

  function getTheme(): MndwThemeName {
    return current;
  }

  function setTheme(theme: MndwThemeName): void {
    if (theme === current) {
      return;
    }

    current = theme;
    applyDataset(theme);

    try {
      (deps.storage ?? globalThis.localStorage).setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; the in-memory theme still applies.
    }

    notify(theme);
  }

  function toggleTheme(): void {
    setTheme(current === 'dark' ? 'light' : 'dark');
  }

  function subscribeTheme(callback: ThemeListener): () => void {
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
    };
  }

  return Object.freeze({initTheme, getTheme, setTheme, toggleTheme, subscribeTheme});
}
