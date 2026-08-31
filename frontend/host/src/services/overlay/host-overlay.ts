import type {OverlaySession} from '@mndw/sdk';
import {type Component, mount, unmount} from 'svelte';
import {createPluginOverlayService} from './overlay-manager.svelte.js';

const {service: hostService} = createPluginOverlayService('@host', '@host');

export interface HostModalProps<Result> {
  close: (result: Result) => void;
}

export function openHostModal<Result, Props extends HostModalProps<Result>>(
  component: Component<Props>,
  options: {
    title: string;
    props: Omit<Props, 'close'>;
    showCloseButton?: boolean;
    closeOnEscape?: boolean;
  },
): OverlaySession<Result> {
  return hostService.open<Result>({
    kind: 'modal',
    title: options.title,
    showCloseButton: options.showCloseButton ?? true,
    closeOnEscape: options.closeOnEscape ?? true,
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
        instance = mount(component, {target: element, props});
      } finally {
        finishMount();
      }
    },
  });
}
