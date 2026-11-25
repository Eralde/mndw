import {mount, unmount} from 'svelte';
import type {OverlayService, Translator} from '@mndw/sdk';
import WakeConsentDialog from '../components/WakeConsentDialog.svelte';

export interface WakeDecision {
  confirmed: boolean;
  remember: boolean;
}

const DECLINED: WakeDecision = {confirmed: false, remember: false};

/**
 * Asks in a host dialog whether a read may wake the drive. Everything but the confirm button (Cancel, Escape, a click
 * outside, the shell's close button, any host-initiated close) declines, so a dismissed dialog never starts a read.
 * Aborting `signal` closes the dialog and declines, for a caller whose reason to read went away while it was open.
 */
export async function confirmWake(
  overlay: OverlayService,
  i18n: Translator,
  options: {canRemember: boolean; signal?: AbortSignal},
): Promise<WakeDecision> {
  if (options.signal?.aborted === true) { return DECLINED; }

  const session = overlay.open<WakeDecision>({
    kind: 'modal',
    role: 'alertdialog',
    title: i18n.t('action.refresh-confirmation-title'),
    // The host wires the description to the dialog, which an alert dialog needs for its message.
    description: i18n.t('action.refresh-confirmation'),
    width: 'min(28rem, calc(100vw - 2rem))',
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = mount(WakeConsentDialog, {
        target,
        props: {
          i18n,
          canRemember: options.canRemember,
          onDecision: (confirmed: boolean, remember: boolean) => {
            layer.close({confirmed, remember}, 'action');
          },
        },
      });

      layer.setCleanup(() => {
        void unmount(app);
      });
    },
  });
  const abort = (): void => session.close();

  options.signal?.addEventListener('abort', abort, {once: true});

  const closed = await session.closed;

  options.signal?.removeEventListener('abort', abort);

  return closed.reason === 'action' && closed.result?.confirmed === true ? closed.result : DECLINED;
}
