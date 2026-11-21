import type {OverlayConfirmOptions, OverlayService, OverlaySession} from '@mndw/sdk';
import {type Component, mount, unmount} from 'svelte';
import ConfirmDialog from './ConfirmDialog.svelte';

export interface HostModalProps<Result> {
  close: (result: Result) => void;
}

export function openHostModal<Result, Props extends HostModalProps<Result>>(
  hostService: OverlayService,
  component: Component<Props>,
  options: {
    title: string;
    description?: string;
    role?: 'dialog' | 'alertdialog';
    props: Omit<Props, 'close'>;
    showCloseButton?: boolean;
    closeOnEscape?: boolean;
    closeOnOutsideClick?: boolean;
    context?: Map<unknown, unknown>;
  },
): OverlaySession<Result> {
  return hostService.open<Result>({
    kind: 'modal',
    title: options.title,
    description: options.description,
    role: options.role,
    showCloseButton: options.showCloseButton ?? true,
    closeOnEscape: options.closeOnEscape ?? true,
    closeOnOutsideClick: options.closeOnOutsideClick ?? false,
    mount(element, session) {
      let instance: ReturnType<typeof mount> | undefined;
      let finishMount: () => void = () => {};
      const mounted = new Promise<void>((resolve) => {
        finishMount = resolve;
      });
      const props = {
        ...options.props,
        close(result: Result): void {
          session.close(result);
        },
      } as Props;

      session.setCleanup(async () => {
        await mounted;

        if (instance) {
          await unmount(instance);
        }
      });

      try {
        instance = mount(component, {target: element, props,
          ...(options.context === undefined ? {} : {context: options.context})});
      } finally {
        finishMount();
      }
    },
  });
}

export async function confirmHost(
  hostService: OverlayService,
  options: OverlayConfirmOptions,
): Promise<boolean> {
  const session = openHostModal<boolean, {
    close: (confirmed: boolean) => void;
    confirmLabel?: string;
    cancelLabel?: string;
    danger: boolean;
  }>(hostService, ConfirmDialog, {
    title: options.title,
    description: options.message,
    role: 'alertdialog',
    showCloseButton: false,
    closeOnOutsideClick: true,
    props: {
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      danger: options.danger ?? false,
    },
  });

  const event = await session.closed;

  return event.result === true;
}
