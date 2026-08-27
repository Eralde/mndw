import type {MndwThemeName} from '@mndw/sdk';
import {STORAGE_PREFIX} from '../constants.js';

const THEME_STORAGE_KEY = `${STORAGE_PREFIX}:theme`;
const DEFAULT_THEME: MndwThemeName = 'dark';

type ThemeListener = (theme: MndwThemeName) => void;

let current: MndwThemeName = DEFAULT_THEME;
const listeners = new Set<ThemeListener>();

function readStored(): MndwThemeName {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);

    return value === 'light' || value === 'dark' ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyDataset(theme: MndwThemeName): void {
  document.documentElement.dataset.theme = theme;
}

function notify(theme: MndwThemeName): void {
  for (const listener of listeners) {
    listener(theme);
  }
}

/**
 * Resolve the persisted theme, apply it to the document, and sync any subscribers
 * registered before boot. Call once, before mounting the app.
 */
export function initTheme(): MndwThemeName {
  current = readStored();
  applyDataset(current);
  notify(current);

  return current;
}

export function getTheme(): MndwThemeName {
  return current;
}

export function setTheme(theme: MndwThemeName): void {
  if (theme === current) {
    return;
  }

  current = theme;
  applyDataset(theme);

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; the in-memory theme still applies.
  }

  notify(theme);
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

export function subscribeTheme(callback: ThemeListener): () => void {
  listeners.add(callback);

  return () => {
    listeners.delete(callback);
  };
}
