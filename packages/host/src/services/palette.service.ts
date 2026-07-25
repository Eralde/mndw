import {MNDW_TOKENS, type PaletteTokenMap, paletteToCss, validateImportedPalette} from '@mndw/sdk';
import {mgmtClient} from './mgmt-client.js';

const OVERRIDE_ELEMENT_ID = 'mndw-palette-override';
const OVERRIDE_SELECTOR = ':root:root';

type PaletteListener = (tokens: PaletteTokenMap) => void;

let applied: PaletteTokenMap | null = null;
const listeners = new Set<PaletteListener>();

function element(): HTMLStyleElement {
  const existing = document.getElementById(OVERRIDE_ELEMENT_ID);

  if (existing instanceof HTMLStyleElement) {
    return existing;
  }

  const created = document.createElement('style');

  created.id = OVERRIDE_ELEMENT_ID;
  document.head.appendChild(created);

  return created;
}

function applyOverride(map: PaletteTokenMap | null): void {
  if (map === null) {
    document.getElementById(OVERRIDE_ELEMENT_ID)?.remove();

    return;
  }

  element().textContent = paletteToCss(map, {selector: OVERRIDE_SELECTOR});
}

function clonePalette(palette: PaletteTokenMap): PaletteTokenMap {
  return {
    dark: {...palette.dark},
    light: {...palette.light},
  };
}

function paletteChanged(previous: PaletteTokenMap | null, next: PaletteTokenMap | null): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function notify(): void {
  const tokens = getTokens();

  for (const listener of listeners) {
    listener(clonePalette(tokens));
  }
}

export function getApplied(): PaletteTokenMap | null {
  return applied === null ? null : clonePalette(applied);
}

export function getExportable(): PaletteTokenMap {
  return clonePalette(applied ?? MNDW_TOKENS);
}

export function getTokens(): PaletteTokenMap {
  return getExportable();
}

async function loadPalette(notifyListeners: boolean): Promise<void> {
  const stored = await mgmtClient.getPalette();
  let next: PaletteTokenMap | null = null;

  if (stored !== null) {
    const validation = validateImportedPalette(stored);

    if (validation.palette === null) {
      throw new Error('The device returned an invalid palette.');
    }

    next = validation.palette;
  }

  const changed = paletteChanged(applied, next);

  applied = next;
  applyOverride(next);

  if (notifyListeners && changed) {
    notify();
  }
}

export async function refreshPalette(): Promise<void> {
  await loadPalette(true);
}

export async function initPalette(): Promise<void> {
  try {
    await loadPalette(false);
  } catch (error) {
    console.warn('[mndw] Could not load the device palette; using defaults.', error);
  }
}

export function previewOverride(palette: PaletteTokenMap): void {
  const snapshot = clonePalette(palette);

  applyOverride(snapshot);

  for (const listener of listeners) {
    listener(clonePalette(snapshot));
  }
}

export function discardPreview(): void {
  applyOverride(applied);
  notify();
}

export async function commitOverride(palette: PaletteTokenMap): Promise<void> {
  await mgmtClient.putPalette(palette);
  applied = clonePalette(palette);
  applyOverride(applied);
  notify();
}

export async function resetToDefault(): Promise<void> {
  await mgmtClient.deletePalette();
  applied = null;
  applyOverride(null);
  notify();
}

export function subscribePalette(callback: PaletteListener): () => void {
  listeners.add(callback);

  return () => {
    listeners.delete(callback);
  };
}
