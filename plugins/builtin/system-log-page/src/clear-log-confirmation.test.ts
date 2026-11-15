// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {get} from 'svelte/store';
import type {OverlayCloseEvent, OverlayOpenOptions, OverlayService, OverlaySession, Translator} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {createTranslator} from '@mndw/sdk/svelte';
import enCatalog from '../i18n/en.json';
import ruCatalog from '../i18n/ru.json';
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

function translatorFor(catalog: Record<string, unknown>): Translator {
  return get(createTranslator(createTestI18n(catalog)));
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

  it('renders English clear confirmation copy unchanged', () => {
    const fake = createOverlay();

    opened = fake.opened;
    openClearConfirmation(fake.overlay, translatorFor(enCatalog));

    const dialog = fake.opened[0];
    const content = dialog?.target.querySelector('[role="dialog"]');
    const buttons = [...(dialog?.target.querySelectorAll<HTMLElement>('mndw-button') ?? [])];

    expect(dialog?.options.title).toBe('Clear system log');
    expect(dialog?.options.description).toBe('Remove all current router system-log records?');
    expect(content?.getAttribute('aria-label')).toBe('Clear system log');
    expect(content?.querySelector('p')?.textContent).toBe('Clear all records from the router system log?');
    expect(buttons.map((button) => button.textContent)).toEqual(['Clear log', 'Cancel']);
  });

  it('renders all clear confirmation copy in Russian for the Russian locale', () => {
    const fake = createOverlay();

    opened = fake.opened;
    openClearConfirmation(fake.overlay, translatorFor(ruCatalog));

    const dialog = fake.opened[0];
    const content = dialog?.target.querySelector('[role="dialog"]');
    const buttons = [...(dialog?.target.querySelectorAll<HTMLElement>('mndw-button') ?? [])];

    expect(dialog?.options.title).toBe('Очистить системный журнал');
    expect(dialog?.options.description).toBe('Удалить все текущие записи системного журнала роутера?');
    expect(content?.getAttribute('aria-label')).toBe('Очистить системный журнал');
    expect(content?.querySelector('p')?.textContent).toBe('Очистить все записи системного журнала роутера?');
    expect(buttons.map((button) => button.textContent)).toEqual(['Очистить журнал', 'Отмена']);
  });

  it('composes a modal from host overlay primitives and returns confirm action', async () => {
    const fake = createOverlay();

    opened = fake.opened;

    const resultPromise = openClearConfirmation(fake.overlay, translatorFor(enCatalog));
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

    const cancelPromise = openClearConfirmation(cancelFake.overlay, translatorFor(enCatalog));

    cancelFake.opened[0]?.target.querySelectorAll<HTMLElement>('mndw-button')[1]?.click();
    await expect(cancelPromise).resolves.toEqual({reason: 'api', result: {confirmed: false}});

    const dismissFake = createOverlay();

    opened.push(...dismissFake.opened);

    const dismissPromise = openClearConfirmation(dismissFake.overlay, translatorFor(enCatalog));

    dismissFake.opened[0]?.emitClose({reason: 'escape'});
    await expect(dismissPromise).resolves.toEqual({reason: 'escape'});
  });

  it('registers cleanup for dialog listeners', () => {
    const fake = createOverlay();

    opened = fake.opened;
    openClearConfirmation(fake.overlay, translatorFor(enCatalog));

    expect(fake.opened[0]?.cleanup).toBeTypeOf('function');
    fake.opened[0]?.cleanup?.();
    fake.opened[0]?.target.querySelectorAll<HTMLElement>('mndw-button')[0]?.click();
    expect(fake.opened[0]?.close).not.toHaveBeenCalled();
  });
});
