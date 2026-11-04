import {MNDW_TOKENS, type PaletteTokenMap} from '@mndw/sdk';
import {paletteToCss, validateImportedPalette} from '@mndw/sdk-internal/palette';
import {type MgmtClient, mgmtClient} from './mgmt-client.js';

const OVERRIDE_ELEMENT_ID = 'mndw-palette-override';
const OVERRIDE_SELECTOR = ':root:root';

type PaletteListener = (tokens: PaletteTokenMap) => void;

function element(hostDocument: Document): HTMLStyleElement {
  const existing = hostDocument.getElementById(OVERRIDE_ELEMENT_ID);

  if (existing instanceof HTMLStyleElement) {
    return existing;
  }

  const created = hostDocument.createElement('style');

  created.id = OVERRIDE_ELEMENT_ID;
  hostDocument.head.appendChild(created);

  return created;
}

function applyOverride(hostDocument: Document, map: PaletteTokenMap | null): void {
  if (map === null) {
    hostDocument.getElementById(OVERRIDE_ELEMENT_ID)?.remove();

    return;
  }

  element(hostDocument).textContent = paletteToCss(map, {selector: OVERRIDE_SELECTOR});
}

function clonePalette(palette: PaletteTokenMap): PaletteTokenMap {
  return Object.freeze({
    dark: {...palette.dark},
    light: {...palette.light},
  });
}

function paletteChanged(previous: PaletteTokenMap | null, next: PaletteTokenMap | null): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

export interface PaletteServiceDeps {
  mgmtClient: Pick<MgmtClient, 'getPalette' | 'putPalette' | 'deletePalette'>;
  document?: Document;
}

export interface PaletteService {
  getApplied(): PaletteTokenMap | null;
  getExportable(): PaletteTokenMap;
  getTokens(): PaletteTokenMap;
  refreshPalette(): Promise<void>;
  initPalette(): Promise<void>;
  previewOverride(palette: PaletteTokenMap): void;
  discardPreview(): void;
  commitOverride(palette: PaletteTokenMap): Promise<void>;
  resetToDefault(): Promise<void>;
  subscribePalette(callback: PaletteListener): () => void;
}

export function createPaletteService(deps: PaletteServiceDeps): PaletteService {
  const hostDocument = deps.document ?? globalThis.document;
  let applied: PaletteTokenMap | null = null;
  const listeners = new Set<PaletteListener>();

  const getExportable = (): PaletteTokenMap => clonePalette(applied ?? MNDW_TOKENS);

  const notify = (): void => {
    const tokens = getExportable();

    for (const listener of listeners) {
      listener(clonePalette(tokens));
    }
  };

  const loadPalette = async (notifyListeners: boolean): Promise<void> => {
    const stored = await deps.mgmtClient.getPalette();
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
    applyOverride(hostDocument, next);

    if (notifyListeners && changed) {
      notify();
    }
  };

  return {
    getApplied: () => applied === null ? null : clonePalette(applied),
    getExportable,
    getTokens: getExportable,
    refreshPalette: async (): Promise<void> => {
      await loadPalette(true);
    },
    initPalette: async (): Promise<void> => {
      try {
        await loadPalette(false);
      } catch (error) {
        console.warn('[mndw] Could not load the device palette; using defaults.', error);
      }
    },
    previewOverride: (palette): void => {
      const snapshot = clonePalette(palette);

      applyOverride(hostDocument, snapshot);

      for (const listener of listeners) {
        listener(clonePalette(snapshot));
      }
    },
    discardPreview: (): void => {
      applyOverride(hostDocument, applied);
      notify();
    },
    commitOverride: async (palette): Promise<void> => {
      await deps.mgmtClient.putPalette(palette);
      applied = clonePalette(palette);
      applyOverride(hostDocument, applied);
      notify();
    },
    resetToDefault: async (): Promise<void> => {
      await deps.mgmtClient.deletePalette();
      applied = null;
      applyOverride(hostDocument, null);
      notify();
    },
    subscribePalette: (callback): () => void => {
      listeners.add(callback);

      return () => {
        listeners.delete(callback);
      };
    },
  };
}

export const paletteService = createPaletteService({mgmtClient});

export const getApplied = (): PaletteTokenMap | null => paletteService.getApplied();
export const getExportable = (): PaletteTokenMap => paletteService.getExportable();
export const getTokens = (): PaletteTokenMap => paletteService.getTokens();
export const refreshPalette = (): Promise<void> => paletteService.refreshPalette();
export const initPalette = (): Promise<void> => paletteService.initPalette();
export const previewOverride = (palette: PaletteTokenMap): void => paletteService.previewOverride(palette);
export const discardPreview = (): void => paletteService.discardPreview();
export const commitOverride = (palette: PaletteTokenMap): Promise<void> => paletteService.commitOverride(palette);
export const resetToDefault = (): Promise<void> => paletteService.resetToDefault();
export const subscribePalette = (callback: PaletteListener): () => void => paletteService.subscribePalette(callback);
