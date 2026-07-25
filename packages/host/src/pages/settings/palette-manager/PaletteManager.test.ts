import {MNDW_TOKENS, type PaletteTokenMap} from '@mndw/sdk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

const refreshPalette = vi.fn<() => Promise<void>>();
const previewOverride = vi.fn<(palette: PaletteTokenMap) => void>();
const discardPreview = vi.fn<() => void>();
const commitOverride = vi.fn<(palette: PaletteTokenMap) => Promise<void>>();
const resetToDefault = vi.fn<() => Promise<void>>();
const getExportable = vi.fn<() => PaletteTokenMap>();

vi.mock('../../../services/palette.service.js', () => ({
  refreshPalette: (): Promise<void> => refreshPalette(),
  previewOverride: (palette: PaletteTokenMap): void => previewOverride(palette),
  discardPreview: (): void => discardPreview(),
  commitOverride: (palette: PaletteTokenMap): Promise<void> => commitOverride(palette),
  resetToDefault: (): Promise<void> => resetToDefault(),
  getExportable: (): PaletteTokenMap => getExportable(),
  getApplied: () => null,
}));

import PaletteManager from './PaletteManager.svelte';

const valid = JSON.parse(JSON.stringify(MNDW_TOKENS)) as PaletteTokenMap;

let target: HTMLDivElement;
let component: ReturnType<typeof mount>;

function render(): void {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(PaletteManager, {target, props: {}});
  flushSync();
}

async function waitForIdle(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false);
  });
}

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
  };
}

async function chooseFile(contents: string): Promise<void> {
  const input = target.querySelector<HTMLInputElement>('input[type="file"]');

  if (!input) {
    throw new Error('no file input rendered');
  }

  const file = new File([contents], 'mndw-palette.json', {type: 'application/json'});

  Object.defineProperty(input, 'files', {value: [file], configurable: true});
  input.dispatchEvent(new Event('change', {bubbles: true}));

  await vi.waitFor(() => {
    flushSync();
    expect(previewOverride.mock.calls.length + target.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.trim().startsWith(label)
  );

  if (!found) {
    throw new Error(`no button labelled "${label}"; saw: ${
      [...target.querySelectorAll('button')]
        .map((candidate) => candidate.textContent?.trim())
        .join(' | ')
    }`);
  }

  return found;
}

beforeEach(() => {
  refreshPalette.mockReset().mockResolvedValue(undefined);
  previewOverride.mockReset();
  discardPreview.mockReset();
  commitOverride.mockReset().mockResolvedValue(undefined);
  resetToDefault.mockReset().mockResolvedValue(undefined);
  getExportable.mockReset().mockReturnValue(valid);
});

afterEach(() => {
  if (component) {
    void unmount(component);
  }

  target?.remove();
});

describe('PaletteManager', () => {
  it('shows status and disables all controls while the initial load is pending', () => {
    const pending = deferred<void>();

    refreshPalette.mockImplementationOnce(() => pending.promise);
    render();

    expect(target.querySelector('[role="status"]')?.textContent).toContain('Loading palette');
    expect(target.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(button('Export palette').disabled).toBe(true);
    expect(button('Reset to default').disabled).toBe(true);

    pending.resolve(undefined);
  });

  it('loads the device palette on mount', () => {
    render();

    expect(refreshPalette).toHaveBeenCalledTimes(1);
  });

  it('previews a valid imported file and shows its contrast warnings by theme', async () => {
    const warned = JSON.parse(JSON.stringify(valid)) as PaletteTokenMap;

    warned.dark.text = warned.dark.surface;

    render();
    await waitForIdle();
    await chooseFile(JSON.stringify(warned));

    expect(previewOverride).toHaveBeenCalledWith(warned);
    expect(target.textContent).toContain('text on surface');
    expect(target.textContent?.toLowerCase()).toContain('dark');
  });

  it('discards a preview and returns to idle', async () => {
    render();
    await waitForIdle();
    await chooseFile(JSON.stringify(valid));

    button('Discard').click();
    flushSync();

    expect(discardPreview).toHaveBeenCalledTimes(1);
    expect(commitOverride).not.toHaveBeenCalled();
  });

  it('commits a previewed palette', async () => {
    render();
    await waitForIdle();
    await chooseFile(JSON.stringify(valid));

    button('Confirm').click();
    await vi.waitFor(() => expect(commitOverride).toHaveBeenCalledWith(valid));
    await vi.waitFor(() => expect(target.textContent).toContain('Saved'));
    flushSync();

    expect(target.textContent).toContain('Saved');
  });

  it('stays on the preview when the commit fails', async () => {
    commitOverride.mockRejectedValue(new Error('device offline'));

    render();
    await waitForIdle();
    await chooseFile(JSON.stringify(valid));

    button('Confirm').click();
    await vi.waitFor(() => expect(target.textContent).toContain('device offline'));
    flushSync();

    expect(button('Confirm')).toBeTruthy();
    expect(discardPreview).not.toHaveBeenCalled();
  });

  it('disables the file input while a file is being read', async () => {
    const text = deferred<string>();

    render();
    await waitForIdle();

    const input = target.querySelector<HTMLInputElement>('input[type="file"]');

    if (!input) {
      throw new Error('no file input rendered');
    }

    const file = new File([JSON.stringify(valid)], 'mndw-palette.json', {type: 'application/json'});

    vi.spyOn(file, 'text').mockReturnValue(text.promise);
    Object.defineProperty(input, 'files', {value: [file], configurable: true});
    input.dispatchEvent(new Event('change', {bubbles: true}));
    flushSync();

    expect(input.disabled).toBe(true);
    expect(target.querySelector('[role="status"]')?.textContent).toContain('Reading palette');
    text.resolve(JSON.stringify(valid));

    await vi.waitFor(() => expect(previewOverride).toHaveBeenCalledWith(valid));
  });

  it('disables confirm and discard while committing', async () => {
    const commit = deferred<void>();

    commitOverride.mockImplementationOnce(() => commit.promise);
    render();
    await waitForIdle();
    await chooseFile(JSON.stringify(valid));

    button('Confirm').click();
    flushSync();

    expect(button('Confirm').disabled).toBe(true);
    expect(button('Discard').disabled).toBe(true);

    commit.resolve(undefined);
    await vi.waitFor(() => expect(target.textContent).toContain('Saved'));
  });

  it('reports a structurally invalid file without calling the daemon', async () => {
    render();
    await waitForIdle();
    await chooseFile(JSON.stringify({dark: {bg: 'nope'}}));

    const alert = target.querySelector('[role="alert"]');

    expect(alert).not.toBeNull();
    expect(previewOverride).not.toHaveBeenCalled();
    expect(commitOverride).not.toHaveBeenCalled();
    expect(target.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false);
    expect(button('Export palette').disabled).toBe(true);
    expect(button('Reset to default').disabled).toBe(true);

    button('Dismiss').click();
    flushSync();
    expect(button('Export palette').disabled).toBe(false);
  });

  it('reports a file that is not JSON at all', async () => {
    render();
    await waitForIdle();
    await chooseFile('not json');

    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Invalid JSON file.');
  });

  it('resets to default and disables the button while the request is in flight', async () => {
    let release: () => void = () => {};

    resetToDefault.mockImplementation(() =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    render();
    await waitForIdle();

    button('Reset to default').click();
    flushSync();
    button('Yes, reset').click();
    flushSync();

    const resetButton = button('Reset to default');

    expect(resetButton.disabled).toBe(true);
    expect(target.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(button('Export palette').disabled).toBe(true);
    resetButton.click();
    flushSync();
    expect(resetToDefault).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(button('Reset to default').disabled).toBe(false));
  });

  it('shows a retryable banner when the initial load fails, and stays usable', async () => {
    refreshPalette.mockRejectedValueOnce(new Error('device offline'));

    render();
    await vi.waitFor(() => expect(target.textContent).toContain('device offline'));
    flushSync();

    expect(target.querySelector('input[type="file"]')).not.toBeNull();
    expect(button('Export palette').disabled).toBe(false);

    const retry = deferred<void>();

    refreshPalette.mockImplementationOnce(() => retry.promise);
    button('Retry').click();
    await vi.waitFor(() => expect(refreshPalette).toHaveBeenCalledTimes(2));
    expect(button('Retry').disabled).toBe(true);
    retry.resolve(undefined);
  });

  it('downloads the exportable palette while idle and disables export during preview', async () => {
    const createObjectURL = vi.fn(() => 'blob:mndw');
    const revokeObjectURL = vi.fn();
    const realCreate = URL.createObjectURL.bind(URL);
    const realRevoke = URL.revokeObjectURL.bind(URL);

    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

    const clicks: HTMLAnchorElement[] = [];
    const realClick = HTMLAnchorElement.prototype.click.bind(HTMLAnchorElement.prototype);

    HTMLAnchorElement.prototype.click = function stub(this: HTMLAnchorElement): void {
      clicks.push(this);
    };

    try {
      render();
      await waitForIdle();
      button('Export palette').click();
      flushSync();

      expect(clicks).toHaveLength(1);
      expect(clicks[0].download).toBe('mndw-palette.json');
      expect(createObjectURL).toHaveBeenCalledTimes(1);

      await chooseFile(JSON.stringify(valid));
      expect(
        [...target.querySelectorAll('button')].some((candidate) =>
          candidate.textContent?.trim().startsWith('Export palette')
        ),
      )
        .toBe(false);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
  });
});
