import type {OverlayCloseEvent, OverlayService} from '@mndw/sdk';
import type {TranslatorFn} from '../status-labels';

export type AutoLayoutResult = 'confirm' | 'cancel';

export function openAutoLayoutConfirmation(
  overlay: OverlayService,
  t: TranslatorFn,
): Promise<OverlayCloseEvent<AutoLayoutResult>> {
  const session = overlay.open<AutoLayoutResult>({
    kind: 'modal',
    title: t('auto-layout.title'),
    description: t('auto-layout.description'),
    closeOnEscape: true,
    closeOnOutsideClick: true,
    trapFocus: true,
    restoreFocus: true,
    lockScroll: true,
    mount(target, layer, signal) {
      const dialog = document.createElement('div');
      const actions = document.createElement('div');
      const confirmButton = document.createElement('mndw-button');
      const cancelButton = document.createElement('mndw-button');

      dialog.className = 'auto-layout-confirmation';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', t('auto-layout.title'));
      confirmButton.textContent = t('action.confirm');
      confirmButton.setAttribute('variant', 'danger');
      cancelButton.textContent = t('action.cancel');
      cancelButton.setAttribute('variant', 'secondary');
      actions.append(confirmButton, cancelButton);
      dialog.append(actions);
      target.append(dialog);

      const confirm = (): void => {
        layer.close('confirm', 'action');
      };
      const cancel = (): void => {
        layer.close('cancel', 'action');
      };
      const cleanup = (): void => {
        confirmButton.removeEventListener('click', confirm);
        cancelButton.removeEventListener('click', cancel);
        signal.removeEventListener('abort', cleanup);
        dialog.remove();
      };

      confirmButton.addEventListener('click', confirm);
      cancelButton.addEventListener('click', cancel);
      signal.addEventListener('abort', cleanup, {once: true});
      layer.setCleanup(cleanup);
    },
  });

  return session.closed;
}
