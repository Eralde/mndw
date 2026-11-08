import type {HostNavigation, HostTarget, OverlayCloseEvent, OverlayService} from '@mndw/sdk';
import type {ExtraFeaturesAvailability, ExtraFeaturesSetupReason} from '../services/mws-data.service';
import type {TranslatorFn} from '../status-labels';

let nextPopoverId = 0;

export interface ExtraFeaturesPopoverController {
  readonly closed: Promise<OverlayCloseEvent>;
  update(availability: ExtraFeaturesAvailability, setupReasons?: readonly ExtraFeaturesSetupReason[]): void;
  close(): void;
}

export function openExtraFeaturesPopover(
  overlay: OverlayService,
  anchor: HTMLElement,
  availability: ExtraFeaturesAvailability,
  t: TranslatorFn,
  navigation: HostNavigation,
  setupReasons: readonly ExtraFeaturesSetupReason[] = [],
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
  const settingsTarget: HostTarget = {kind: 'settings', tab: 'general'};
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
  group.style.background = 'var(--mndw-surface-raised)';
  group.style.color = 'var(--mndw-text)';
  group.style.borderWidth = '1px';
  group.style.borderStyle = 'solid';
  group.style.borderColor = 'var(--mndw-border)';
  group.style.borderRadius = 'var(--mndw-radius-md)';
  group.style.boxShadow = 'var(--mndw-shadow-2)';
  group.append(title, body);

  action.addEventListener('click', (event) => {
    if (navigation.navigate(settingsTarget)) {
      event.preventDefault();
    }
  });

  const render = (
    next: ExtraFeaturesAvailability,
    reasons: readonly ExtraFeaturesSetupReason[] = setupReasons,
  ): void => {
    title.textContent = t(`extra-features.popover.${next}.title`);

    const bodyKey = next === 'unavailable' && reasons.includes('extender-session')
      ? 'extra-features.popover.unavailable.extender-session.body'
      : next === 'blocked'
      ? reasons.length === 0
        ? 'extra-features.popover.blocked.body'
        : reasons.includes('permission') && reasons.includes('controller-token')
        ? 'extra-features.popover.blocked.combined.body'
        : reasons.includes('permission')
        ? 'extra-features.popover.blocked.permission.body'
        : reasons.includes('controller-token')
        ? 'extra-features.popover.blocked.controller-token.body'
        : 'extra-features.popover.blocked.generic.body'
      : `extra-features.popover.${next}.body`;

    body.textContent = t(bodyKey);

    const href = navigation.href(settingsTarget);

    if (href === undefined) {
      action.remove();
    } else {
      action.textContent = t('extra-features.popover.view-settings');
      action.href = href;
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
