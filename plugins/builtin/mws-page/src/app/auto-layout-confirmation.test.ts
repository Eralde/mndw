// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {OverlayCloseEvent, OverlayOpenOptions, OverlayService, OverlaySession} from '@mndw/sdk';
import {type AutoLayoutResult, openAutoLayoutConfirmation} from './auto-layout-confirmation';

interface Opened {
  options: OverlayOpenOptions<AutoLayoutResult>;
  target: HTMLElement;
  cleanup: (() => void | Promise<void>) | null;
  emitClose(event: OverlayCloseEvent<AutoLayoutResult>): void;
  close: ReturnType<typeof vi.fn>;
}

function createOverlay(): {overlay: OverlayService; opened: Opened[]} {
  const opened: Opened[] = [];
  const overlay = {
    open: (options: OverlayOpenOptions<AutoLayoutResult>) => {
      const target = document.createElement('div');
      const controller = new AbortController();
      let resolveClosed: (event: OverlayCloseEvent<AutoLayoutResult>) => void = () => undefined;
      const closed = new Promise<OverlayCloseEvent<AutoLayoutResult>>((resolve) => {
        resolveClosed = resolve;
      });
      const record: Opened = {
        options,
        target,
        cleanup: null,
        emitClose: (event) => resolveClosed(event),
        close: vi.fn((result?: AutoLayoutResult, reason: 'api' | 'action' = 'api') => {
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
      } as unknown as OverlaySession<AutoLayoutResult>;

      opened.push(record);
      void options.mount(target, layer, controller.signal);

      return layer;
    },
  } as unknown as OverlayService;

  return {overlay, opened};
}

const t = (key: string): string => ({
  'auto-layout.title': 'Reset map layout?',
  'auto-layout.description': 'This removes saved node positions for this session.',
  'action.confirm': 'Confirm',
  'action.cancel': 'Cancel',
}[key] ?? key);

describe('openAutoLayoutConfirmation', () => {
  let opened: Opened[] = [];

  afterEach(() => {
    for (const modal of opened) {
      modal.cleanup?.();
      modal.target.remove();
    }

    opened = [];
  });

  it('opens a modal with localized confirmation actions', async () => {
    const fake = createOverlay();

    opened = fake.opened;

    const resultPromise = openAutoLayoutConfirmation(fake.overlay, t);
    const modal = fake.opened[0];

    expect(modal?.options.kind).toBe('modal');
    expect(modal?.options.title).toBe('Reset map layout?');
    expect(modal?.options.description).toBe('This removes saved node positions for this session.');
    expect(modal?.options.closeOnEscape).toBe(true);
    expect(modal?.options.closeOnOutsideClick).toBe(true);
    expect(modal?.target.querySelectorAll('mndw-button')).toHaveLength(2);

    modal?.target.querySelectorAll<HTMLElement>('mndw-button')[0]?.click();

    await expect(resultPromise).resolves.toEqual({reason: 'action', result: 'confirm'});
    expect(modal?.close).toHaveBeenCalledWith('confirm', 'action');
  });

  it('returns explicit cancel and preserves host dismissal without confirmation', async () => {
    const cancelFake = createOverlay();

    opened = cancelFake.opened;

    const cancelPromise = openAutoLayoutConfirmation(cancelFake.overlay, t);

    cancelFake.opened[0]?.target.querySelectorAll<HTMLElement>('mndw-button')[1]?.click();
    await expect(cancelPromise).resolves.toEqual({reason: 'action', result: 'cancel'});

    const dismissFake = createOverlay();

    opened.push(...dismissFake.opened);

    const dismissPromise = openAutoLayoutConfirmation(dismissFake.overlay, t);

    dismissFake.opened[0]?.emitClose({reason: 'escape'});
    await expect(dismissPromise).resolves.toEqual({reason: 'escape'});
  });

  it('registers cleanup for modal listeners', () => {
    const fake = createOverlay();

    opened = fake.opened;
    openAutoLayoutConfirmation(fake.overlay, t);

    expect(fake.opened[0]?.cleanup).toBeTypeOf('function');
    fake.opened[0]?.cleanup?.();
    fake.opened[0]?.target.querySelectorAll<HTMLElement>('mndw-button')[0]?.click();

    expect(fake.opened[0]?.close).not.toHaveBeenCalled();
  });
});
