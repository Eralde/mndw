import {flushSync, settled} from 'svelte';
import type {OverlayCloseEvent, OverlayCloseReason, OverlayOpenOptions, OverlayService} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it} from 'vitest';
import enCatalog from '../../i18n/en.json';
import ruCatalog from '../../i18n/ru.json';
import {type WakeDecision, confirmWake} from './confirm-wake';

const i18n = createTestI18n(enCatalog);

interface FakeOverlay {
  service: OverlayService;
  options: OverlayOpenOptions<WakeDecision>[];
  /** How many times the plugin asked the layer to close. */
  closeCalls: () => number;
  target: () => HTMLElement;
  /** Closes the dialog the way the host does for Escape, an outside click or navigation. */
  dismiss: (reason: OverlayCloseReason) => void;
}

const targets: HTMLElement[] = [];

function createOverlay(): FakeOverlay {
  const options: OverlayOpenOptions<WakeDecision>[] = [];
  let finish: (event: OverlayCloseEvent<WakeDecision>) => void = () => {};
  let cleanup: () => void | Promise<void> = () => {};
  let closeCalls = 0;
  const target = document.createElement('div');

  document.body.append(target);
  targets.push(target);

  const service = {
    open: (opened: OverlayOpenOptions<WakeDecision>) => {
      const closed = new Promise<OverlayCloseEvent<WakeDecision>>((resolve) => {
        finish = resolve;
      });
      const layer = {
        closed,
        setCleanup: (next: () => void | Promise<void>) => {
          cleanup = next;
        },
        close: (result?: WakeDecision, reason: 'api' | 'action' = 'api') => {
          closeCalls += 1;
          void cleanup();
          finish({reason, result});
        },
      };

      options.push(opened);
      opened.mount(target, layer as never, new AbortController().signal);

      return layer as never;
    },
  } as unknown as OverlayService;

  return {
    service,
    options,
    closeCalls: () => closeCalls,
    target: () => target,
    dismiss: (reason) => {
      void cleanup();
      finish({reason});
    },
  };
}

const control = (overlay: FakeOverlay, testId: string): HTMLElement | null => {
  return overlay.target().querySelector<HTMLElement>(`[data-testid="${testId}"]`);
};
const click = async (overlay: FakeOverlay, testId: string): Promise<void> => {
  control(overlay, testId)?.click();
  await settled();
  flushSync();
};
const tickRemember = async (overlay: FakeOverlay): Promise<void> => {
  control(overlay, 'remember-wake-consent')?.dispatchEvent(
    new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {checked: true}}),
  );
  await settled();
};

afterEach(() => {
  for (const target of targets.splice(0)) { target.remove(); }
});

describe('confirmWake', () => {
  it.each([
    ['en', enCatalog, 'Read S.M.A.R.T. data?', 'Reading this device may wake it from standby.'],
    ['ru', ruCatalog, 'Прочитать данные S.M.A.R.T.?', 'Чтение может вывести накопитель из режима ожидания.'],
  ])('opens a modal alert dialog with the question and the explanation in %s', async (_name, catalog, title, text) => {
    const overlay = createOverlay();
    const decision = confirmWake(overlay.service, createTestI18n(catalog), {canRemember: true});

    await settled();

    expect(overlay.options[0]).toMatchObject({
      kind: 'modal',
      role: 'alertdialog',
      title,
      description: text,
      closeOnOutsideClick: true,
    });
    await click(overlay, 'cancel-wake');
    await decision;
  });

  it.each([
    ['without the checkbox ticked', false],
    ['with the checkbox ticked', true],
  ])('confirms %s', async (_name, remember) => {
    const overlay = createOverlay();
    const decision = confirmWake(overlay.service, i18n, {canRemember: true});

    await settled();

    if (remember) { await tickRemember(overlay); }

    await click(overlay, 'confirm-refresh');

    await expect(decision).resolves.toEqual({confirmed: true, remember});
    expect(overlay.target().childElementCount).toBe(0);
  });

  it('offers no checkbox for a drive that cannot be remembered', async () => {
    const overlay = createOverlay();
    const decision = confirmWake(overlay.service, i18n, {canRemember: false});

    await settled();

    expect(control(overlay, 'remember-wake-consent')).toBeNull();
    await click(overlay, 'confirm-refresh');
    await expect(decision).resolves.toEqual({confirmed: true, remember: false});
  });

  it('declines on Cancel, even when the checkbox was ticked', async () => {
    const overlay = createOverlay();
    const decision = confirmWake(overlay.service, i18n, {canRemember: true});

    await settled();
    await tickRemember(overlay);
    await click(overlay, 'cancel-wake');

    await expect(decision).resolves.toEqual({confirmed: false, remember: false});
  });

  it('closes the dialog and declines when its signal aborts', async () => {
    const overlay = createOverlay();
    const abort = new AbortController();
    const decision = confirmWake(overlay.service, i18n, {canRemember: true, signal: abort.signal});

    await settled();
    abort.abort();

    await expect(decision).resolves.toEqual({confirmed: false, remember: false});
    expect(overlay.closeCalls()).toBe(1);
    expect(overlay.target().childElementCount).toBe(0);
  });

  it('opens nothing when its signal is already aborted', async () => {
    const overlay = createOverlay();

    await expect(confirmWake(overlay.service, i18n, {canRemember: true, signal: AbortSignal.abort()})).resolves
      .toEqual({confirmed: false, remember: false});
    expect(overlay.options).toHaveLength(0);
  });

  // The shell's × button closes with reason 'action' and no result; only a confirmed result may count.
  it.each<OverlayCloseReason>(['action', 'escape', 'outside-click', 'plugin-unmount'])(
    'declines when the host closes the dialog on %s',
    async (reason) => {
      const overlay = createOverlay();
      const decision = confirmWake(overlay.service, i18n, {canRemember: true});

      await settled();
      overlay.dismiss(reason);

      await expect(decision).resolves.toEqual({confirmed: false, remember: false});
      expect(overlay.target().childElementCount).toBe(0);
    },
  );
});
