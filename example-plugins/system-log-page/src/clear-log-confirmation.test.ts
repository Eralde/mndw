// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {OverlayCloseEvent, OverlayOpenOptions, OverlayService, OverlaySession} from '@mndw/sdk';
import {type ClearResult, openClearConfirmation} from './clear-log-confirmation';

interface Opened {
  options: OverlayOpenOptions<ClearResult>;
  target: HTMLElement;
  cleanup: (() => void | Promise<void>) | null;
  emitClose(event: OverlayCloseEvent<ClearResult>): void;
  close: ReturnType<typeof vi.fn>;
}

function createOverlay(): {overlay: OverlayService; opened: Opened[]} {
  const opened: Opened[] = [];
  const overlay = {
    open: (options: OverlayOpenOptions<ClearResult>) => {
      const target = document.createElement('div');
      const controller = new AbortController();
      let resolveClosed: (event: OverlayCloseEvent<ClearResult>) => void = () => undefined;
      const closed = new Promise<OverlayCloseEvent<ClearResult>>((resolve) => {
        resolveClosed = resolve;
      });
      const record: Opened = {
        options,
        target,
        cleanup: null,
        emitClose: (event) => resolveClosed(event),
        close: vi.fn((result?: ClearResult, reason: 'api' | 'action' = 'api') => {
          resolveClosed({reason, result});
        }),
      };
      const layer = {
        signal: controller.signal,
        contentElement: target,
        hostElement: target,
        state: 'open',
        isOpen: true,
        closed,
        close: record.close,
        setCleanup: (cleanup: () => void | Promise<void>) => {
          record.cleanup = cleanup;
        },
      } as unknown as OverlaySession<ClearResult>;

      opened.push(record);
      void options.mount(target, layer, controller.signal);

      return layer;
    },
  } as unknown as OverlayService;

  return {overlay, opened};
}

describe('openClearConfirmation', () => {
  let opened: Opened[] = [];

  afterEach(() => {
    for (const dialog of opened) {
      dialog.cleanup?.();
      dialog.target.remove();
    }

    opened = [];
  });

  it('composes a modal from host overlay primitives and returns confirm action', async () => {
    const fake = createOverlay();

    opened = fake.opened;

    const resultPromise = openClearConfirmation(fake.overlay);
    const dialog = fake.opened[0];

    expect(dialog.options.kind).toBe('modal');
    expect(dialog.options.closeOnEscape).toBe(true);
    expect(dialog.options.closeOnOutsideClick).toBe(true);
    expect(dialog.options.trapFocus).toBe(true);
    expect(dialog.target.textContent).toMatch(/clear.*log/i);
    expect(dialog.target.querySelectorAll('mndw-button')).toHaveLength(2);

    dialog.target.querySelectorAll<HTMLElement>('mndw-button')[0]?.click();

    await expect(resultPromise).resolves.toEqual({reason: 'action', result: {confirmed: true}});
    expect(dialog.close).toHaveBeenCalledWith({confirmed: true}, 'action');
  });

  it('returns explicit cancel and preserves host dismissal without confirmation', async () => {
    const cancelFake = createOverlay();

    opened = cancelFake.opened;

    const cancelPromise = openClearConfirmation(cancelFake.overlay);

    cancelFake.opened[0]?.target.querySelectorAll<HTMLElement>('mndw-button')[1]?.click();
    await expect(cancelPromise).resolves.toEqual({reason: 'api', result: {confirmed: false}});

    const dismissFake = createOverlay();

    opened.push(...dismissFake.opened);

    const dismissPromise = openClearConfirmation(dismissFake.overlay);

    dismissFake.opened[0]?.emitClose({reason: 'escape'});
    await expect(dismissPromise).resolves.toEqual({reason: 'escape'});
  });

  it('registers cleanup for dialog listeners', () => {
    const fake = createOverlay();

    opened = fake.opened;
    openClearConfirmation(fake.overlay);

    expect(fake.opened[0]?.cleanup).toBeTypeOf('function');
    fake.opened[0]?.cleanup?.();
    fake.opened[0]?.target.querySelectorAll<HTMLElement>('mndw-button')[0]?.click();
    expect(fake.opened[0]?.close).not.toHaveBeenCalled();
  });
});
