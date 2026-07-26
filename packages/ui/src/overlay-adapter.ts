import type {OverlayCloseReason, OverlayService} from '@mndw/sdk';
import type {UiCloseReason, UiLayer, UiLayerOptions, UiOverlayProvider} from './overlay.js';

function toUiReason(reason: OverlayCloseReason): UiCloseReason {
  switch (reason) {
    case 'escape':
      return 'escape';
    case 'outside-click':
      return 'outside';
    case 'host-navigation':
    case 'plugin-unmount':
    case 'replaced':
      return 'detached';
    default:
      return 'api';
  }
}

export function adaptOverlayService(service: OverlayService): UiOverlayProvider {
  return {
    open(options: UiLayerOptions): UiLayer {
      if (options.presentation === 'sheet') {
        const session = service.open({
          kind: 'drawer',
          placement: 'bottom',
          title: options.title ?? 'Select option',
          showCloseButton: true,
          closeOnEscape: true,
          closeOnOutsideClick: true,
          trapFocus: true,
          restoreFocus: true,
          lockScroll: true,
          width: '100%',
          height: 'auto',
          maxHeight: '100dvh',
          className: 'mndw-ui-select-sheet',
          mount(target) {
            target.style.removeProperty('height');
            target.style.minHeight = '0';
          },
        });

        return {
          contentElement: session.contentElement,
          closed: session.closed.then((event) => toUiReason(event.reason)),
          close: () => {
            session.close();
          },
          reposition: () => {},
        };
      }

      const layer = service.createLayer({
        kind: 'popover',
        anchor: {element: options.anchor},
        placement: 'bottom-start',
        closeOnEscape: true,
        closeOnOutsideClick: true,
      });

      layer.markReady();

      return {
        contentElement: layer.contentElement,
        closed: layer.closed.then((event) => toUiReason(event.reason)),
        close: () => {
          layer.close();
        },
        reposition: () => {
          layer.update({anchor: {element: options.anchor}});
        },
      };
    },
  };
}
