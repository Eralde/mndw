// @vitest-environment happy-dom
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_TOKENS, type PaletteTokenMap} from '@mndw/sdk';

const getPalette = vi.fn<() => Promise<unknown>>();
const putPalette = vi.fn<(palette: PaletteTokenMap) => Promise<void>>();
const deletePalette = vi.fn<() => Promise<void>>();

vi.mock('./mgmt-client.js', () => ({
  mgmtClient: {
    getPalette: (): ReturnType<typeof getPalette> => getPalette(),
    putPalette: (palette: PaletteTokenMap): ReturnType<typeof putPalette> => putPalette(palette),
    deletePalette: (): ReturnType<typeof deletePalette> => deletePalette(),
  },
}));

const override = JSON.parse(JSON.stringify(MNDW_TOKENS)) as PaletteTokenMap;

override.dark.accent = '#ff0000';
override.light.accent = '#00ff00';

function overrideElement(): HTMLElement | null {
  return document.getElementById('mndw-palette-override');
}

let service: typeof import('./palette.service.js');

beforeEach(async () => {
  document.head.innerHTML = '';
  vi.resetModules();
  getPalette.mockReset();
  putPalette.mockReset();
  deletePalette.mockReset();
  service = await import('./palette.service.js');
});

describe('initPalette', () => {
  it('uses injected management client and document state', async () => {
    const isolatedDocument = document.implementation.createHTMLDocument('isolated');
    const isolatedGetPalette = vi.fn<() => Promise<PaletteTokenMap | null>>().mockResolvedValue(override);
    const isolatedService = service.createPaletteService({
      mgmtClient: {
        getPalette: isolatedGetPalette,
        putPalette: vi.fn(),
        deletePalette: vi.fn(),
      },
      document: isolatedDocument,
    });

    await isolatedService.initPalette();

    expect(isolatedGetPalette).toHaveBeenCalledTimes(1);
    expect(isolatedDocument.getElementById('mndw-palette-override')).not.toBeNull();
    expect(document.getElementById('mndw-palette-override')).toBeNull();
  });

  it('applies a stored override with boosted selectors', async () => {
    getPalette.mockResolvedValue(override);

    await service.initPalette();

    const element = overrideElement();

    expect(element).not.toBeNull();
    expect(element?.textContent).toContain('--mndw-accent: #ff0000;');
    expect(element?.textContent).toContain(':root:root,');
    expect(element?.textContent).toContain(':root:root[data-theme=\'light\'] {');
    expect(service.getApplied()).toEqual(override);
  });

  it('leaves compiled defaults in place when no override exists', async () => {
    getPalette.mockResolvedValue(null);

    await service.initPalette();

    expect(overrideElement()).toBeNull();
    expect(service.getApplied()).toBeNull();
  });

  it('swallows a failed read so startup can continue', async () => {
    getPalette.mockRejectedValue(new Error('offline'));

    await expect(service.initPalette()).resolves.toBeUndefined();
    expect(overrideElement()).toBeNull();
  });

  it('rejects a structurally invalid device palette without applying it', async () => {
    getPalette.mockResolvedValue({dark: {bg: 'nope'}, light: {}});

    await service.initPalette();

    expect(overrideElement()).toBeNull();
    expect(service.getApplied()).toBeNull();
  });
});

describe('refreshPalette', () => {
  it('propagates errors so Settings can offer retry', async () => {
    getPalette.mockRejectedValue(new Error('offline'));

    await expect(service.refreshPalette()).rejects.toThrow('offline');
  });

  it('leaves applied state and CSS untouched when refresh fails', async () => {
    getPalette.mockResolvedValueOnce(override);
    await service.initPalette();

    getPalette.mockRejectedValueOnce(new Error('offline'));
    await expect(service.refreshPalette()).rejects.toThrow('offline');

    expect(service.getApplied()).toEqual(override);
    expect(overrideElement()?.textContent).toContain('--mndw-accent: #ff0000;');
  });

  it('notifies once for a changed response and not at all for an unchanged response', async () => {
    getPalette.mockResolvedValueOnce(override).mockResolvedValueOnce(override);

    const listener = vi.fn<(tokens: PaletteTokenMap) => void>();

    service.subscribePalette(listener);

    await service.refreshPalette();
    await service.refreshPalette();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('preview and discard', () => {
  it('previews without recording applied state and restores on discard', () => {
    service.previewOverride(override);
    expect(overrideElement()?.textContent).toContain('--mndw-accent: #ff0000;');
    expect(service.getApplied()).toBeNull();

    service.discardPreview();
    expect(overrideElement()).toBeNull();
  });
});

describe('commitOverride and resetToDefault', () => {
  it('records a palette only after PUT succeeds', async () => {
    putPalette.mockResolvedValue(undefined);

    await service.commitOverride(override);

    expect(putPalette).toHaveBeenCalledWith(override);
    expect(service.getApplied()).toEqual(override);
  });

  it('does not record a palette when PUT fails', async () => {
    putPalette.mockRejectedValue(new Error('offline'));

    await expect(service.commitOverride(override)).rejects.toThrow('offline');
    expect(service.getApplied()).toBeNull();
  });

  it('clears state only after DELETE succeeds', async () => {
    putPalette.mockResolvedValue(undefined);
    deletePalette.mockResolvedValue(undefined);
    await service.commitOverride(override);

    await service.resetToDefault();

    expect(deletePalette).toHaveBeenCalledTimes(1);
    expect(service.getApplied()).toBeNull();
    expect(overrideElement()).toBeNull();
  });
});

describe('getExportable, getTokens, and notifications', () => {
  it('uses compiled defaults without an applied override and ignores preview for reads', () => {
    expect(service.getExportable()).toEqual(MNDW_TOKENS);
    expect(service.getTokens()).toEqual(MNDW_TOKENS);
    expect(Object.keys(service.getExportable().dark)).toHaveLength(21);

    service.previewOverride(override);

    expect(service.getExportable()).toEqual(MNDW_TOKENS);
    expect(service.getTokens()).toEqual(MNDW_TOKENS);
  });

  it('returns defensive copies to callers and listeners', async () => {
    putPalette.mockResolvedValue(undefined);
    await service.commitOverride(override);

    const applied = service.getApplied();
    const exportable = service.getExportable();
    const tokens = service.getTokens();
    const listener = vi.fn<(tokens: PaletteTokenMap) => void>();

    service.subscribePalette(listener);

    if (applied === null) {
      throw new Error('expected applied palette');
    }

    applied.dark.accent = '#000000';
    exportable.dark.accent = '#000000';
    tokens.dark.accent = '#000000';
    service.previewOverride(override);

    const listenerTokens = listener.mock.calls[0]?.[0];

    if (listenerTokens === undefined) {
      throw new Error('expected palette listener callback');
    }

    listenerTokens.dark.accent = '#000000';

    expect(service.getApplied()?.dark.accent).toBe('#ff0000');
    expect(service.getExportable().dark.accent).toBe('#ff0000');
    expect(service.getTokens().dark.accent).toBe('#ff0000');
    expect(overrideElement()?.textContent).toContain('--mndw-accent: #ff0000;');
  });
});
