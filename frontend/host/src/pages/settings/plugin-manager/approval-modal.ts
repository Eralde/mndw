import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {openHostModal} from '../../../services/overlay/host-overlay.js';
import type {HostServices} from '../../../host-services.js';
import BackendApprovalModal from './BackendApprovalModal.svelte';

export async function openApprovalModal(
  services: Pick<HostServices, 'locale' | 'hostOverlay'>,
  entry: PluginListEntry,
  signal?: AbortSignal,
): Promise<'approve' | 'deny' | undefined> {
  if (signal?.aborted) {
    return undefined;
  }

  const session = openHostModal<'approve' | 'deny', {
    entry: PluginListEntry;
    close: (result: 'approve' | 'deny') => void;
  }>(
    services.hostOverlay,
    BackendApprovalModal,
    {
      title: services.locale.hostT('settings.backend-approval-title', {label: entry.label}),
      props: {entry},
    },
  );
  const abort = (): void => session.close(undefined);

  signal?.addEventListener('abort', abort, {once: true});

  try {
    const event = await session.closed;

    return event.result;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
