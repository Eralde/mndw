import type {OverlayCloseEvent, OverlayService} from '@mndw/sdk';
import type {ExtraFeaturesAvailability} from '../services/mws-data.service';
import type {TranslatorFn} from '../status-labels';

let nextPopoverId = 0;

export interface ExtraFeaturesPopoverController {
  readonly closed: Promise<OverlayCloseEvent>;
  update(availability: ExtraFeaturesAvailability): void;
  close(): void;
}

export function openExtraFeaturesPopover(
  overlay: OverlayService,
  anchor: HTMLElement,
  availability: ExtraFeaturesAvailability,
  t: TranslatorFn,
): ExtraFeaturesPopoverController {
  const layer = overlay.createLayer({
    kind: 'popover',
    anchor: {element: anchor},
    placement: 'bottom-end',
    closeOnEscape: true,
    closeOnOutsideClick: true,
    trapFocus: false,
    restoreFocus: true,
    lockScroll: false,
  });
  const group = document.createElement('div');
  const title = document.createElement('h3');
  const body = document.createElement('p');
  const action = document.createElement('a');
  let cleaned = false;

  group.className = 'extra-features-popover';
  group.setAttribute('role', 'group');
  nextPopoverId += 1;
  title.id = `extra-features-popover-title-${nextPopoverId}`;
  group.setAttribute('aria-labelledby', title.id);
  group.style.display = 'grid';
  group.style.gap = 'var(--mndw-space-3, 0.75rem)';
  group.style.padding = 'var(--mndw-space-4, 1rem)';
  group.style.maxWidth = '22rem';
  group.append(title, body);

  const render = (next: ExtraFeaturesAvailability): void => {
    title.textContent = t(`extra-features.popover.${next}.title`);
    body.textContent = t(`extra-features.popover.${next}.body`);
    action.remove();

    if (next === 'unavailable') {
      action.textContent = t('extra-features.popover.view-requirements');
      action.href = '/settings/general';
      group.append(action);
    }
  };

  const cleanup = (): void => {
    if (cleaned) {
      return;
    }

    cleaned = true;
    layer.signal.removeEventListener('abort', cleanup);
    group.remove();
  };

  layer.signal.addEventListener('abort', cleanup, {once: true});
  layer.contentElement.append(group);
  layer.setCleanup(cleanup);
  render(availability);
  layer.markReady();

  return {
    closed: layer.closed,
    update: render,
    close: () => layer.close(),
  };
}
