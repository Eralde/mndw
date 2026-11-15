import type {OverlayCloseEvent, OverlayService, Translator} from '@mndw/sdk';

export interface ClearResult {
  readonly confirmed: boolean;
}

export function openClearConfirmation(
  overlay: OverlayService,
  translator: Translator,
): Promise<OverlayCloseEvent<ClearResult>> {
  const session = overlay.open<ClearResult>({
    kind: 'modal',
    title: translator.t('confirm.clear-log.title'),
    description: translator.t('confirm.clear-log.description'),
    closeOnEscape: true,
    closeOnOutsideClick: true,
    trapFocus: true,
    restoreFocus: true,
    lockScroll: true,
    mount(target, layer, signal) {
      const dialog = document.createElement('div');
      const copy = document.createElement('p');
      const actions = document.createElement('div');
      const confirmButton = document.createElement('mndw-button');
      const cancelButton = document.createElement('mndw-button');

      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', translator.t('aria.clear-log-confirmation'));
      copy.textContent = translator.t('confirm.clear-log.question');
      confirmButton.textContent = translator.t('action.clear');
      confirmButton.setAttribute('variant', 'danger');
      cancelButton.textContent = translator.t('action.cancel');
      cancelButton.setAttribute('variant', 'secondary');
      actions.append(confirmButton, cancelButton);
      dialog.append(copy, actions);
      target.append(dialog);

      const confirm = (): void => {
        layer.close({confirmed: true}, 'action');
      };
      const cancel = (): void => {
        layer.close({confirmed: false}, 'api');
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
