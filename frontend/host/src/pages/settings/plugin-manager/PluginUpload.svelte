<script lang="ts">
import {onDestroy} from 'svelte';

import {
  type UploadResult,
  messageForError,
} from '../../../services/mgmt-client.js';
import {hostT} from '../../../services/host-i18n.svelte.js';
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {openApprovalModal} from './approval-modal.js';
import {validateExampleUploadTarget} from './upload-target.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface Props {
  uploadFile: (file: File) => Promise<UploadResult>;
  onInstalled: () => void;
  onApprove: (name: string) => Promise<boolean>;
  onDeny: (name: string) => Promise<boolean>;
  onDismiss: () => void;
  architecture?: string;
  openApproval?: (
    entry: PluginListEntry,
    signal?: AbortSignal,
  ) => Promise<'approve' | 'deny' | undefined>;
}

let {
  uploadFile,
  onInstalled,
  onApprove,
  onDeny,
  onDismiss,
  architecture,
  openApproval = openApprovalModal,
}: Props = $props();
let status = $state<'idle' | 'uploading' | 'busy' | 'success' | 'error'>(
  'idle',
);
let error = $state('');
let success = $state('');
let approvalController: AbortController | undefined;
let destroyed = false;

onDestroy(() => {
  destroyed = true;
  approvalController?.abort();
});

function validate(file: File): string | undefined {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    return 'Choose a ZIP file.';
  }

  if (file.size === 0) {
    return 'The ZIP file is empty.';
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return 'The ZIP file exceeds the 10 MB upload limit.';
  }
}

async function resolvePending(
  entry: PluginListEntry,
  decision: 'approve' | 'deny' | undefined,
): Promise<void> {
  if (destroyed) {
    return;
  }

  if (decision === 'approve') {
    const approved = await onApprove(entry.name);
    if (destroyed) {
      return;
    }
    if (!approved) {
      status = 'idle';

      return;
    }
    success = `Approved "${entry.label}".`;
    status = 'success';
  } else if (decision === 'deny') {
    await onDeny(entry.name);
    if (destroyed) {
      return;
    }
    status = 'idle';
  } else {
    if (destroyed) {
      return;
    }
    onDismiss();
    status = 'idle';
  }
}

async function upload(file: File): Promise<void> {
  if (status === 'uploading' || status === 'busy') {
    return;
  }

  const validationError = validate(file);
  if (validationError) {
    error = validationError;
    status = 'error';

    return;
  }

  const targetError = validateExampleUploadTarget(file.name, architecture);

  if (targetError !== undefined) {
    error = targetError;
    status = 'error';

    return;
  }

  error = '';
  status = 'uploading';
  let result: UploadResult;

  try {
    result = await uploadFile(file);
  } catch (caught) {
    if (destroyed) {
      return;
    }
    error = messageForError(caught);
    status = 'error';

    return;
  }

  if (destroyed) {
    return;
  }

  if (result.status === 'installed') {
    success = `Installed "${result.entry.label}".`;
    status = 'success';
    onInstalled();

    return;
  }

  status = 'busy';
  const controller = new AbortController();
  approvalController = controller;
  let decision: 'approve' | 'deny' | undefined;

  try {
    decision = await openApproval(result.entry, controller.signal);
  } catch (caught) {
    if (destroyed) {
      return;
    }
    error = messageForError(caught);
    status = 'error';

    return;
  } finally {
    if (approvalController === controller) {
      approvalController = undefined;
    }
  }

  if (destroyed || controller.signal.aborted) {
    return;
  }

  await resolvePending(result.entry, decision);
}

function onInput(event: Event): void {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (file) {
    void upload(file);
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) {
    void upload(file);
  }
}
</script>

<div class="mndw-upload">
  <label
    class="mndw-upload__zone"
    ondragover={(event) => event.preventDefault()}
    ondrop={onDrop}
  >
    <input
      accept=".zip"
      aria-label={hostT('settings.upload-plugin-zip')}
      disabled={status === 'uploading' || status === 'busy'}
      type="file"
      onchange={onInput}
    />
    <span>Drop a plugin ZIP here or choose a file.</span>
  </label>

  {#if status === 'uploading'}
    <p
      class="mndw-upload__status"
      role="status"
    >
      Uploading plugin...
    </p>
  {:else if status === 'busy'}
    <p
      class="mndw-upload__status"
      role="status"
    >
      Waiting for approval...
    </p>
  {:else if status === 'success'}
    <p
      class="mndw-upload__success"
      role="status"
    >
      {success}
    </p>
  {:else if status === 'error'}
    <div
      class="mndw-alert mndw-alert--danger"
      role="alert"
    >
      {error}
    </div>
  {/if}
</div>

<style>
.mndw-upload {
  display: grid;
  gap: var(--mndw-space-2);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.mndw-upload__zone {
  display: grid;
  gap: var(--mndw-space-2);
  border: 1px dashed var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  padding: var(--mndw-space-4);
  cursor: pointer;
}

.mndw-upload__zone input {
  min-height: var(--mndw-control-h);
  box-sizing: border-box;
  padding: var(--mndw-space-1) var(--mndw-space-2);
  max-width: 100%;
}

.mndw-upload__status,
.mndw-upload__success {
  margin: 0;
  font-size: var(--mndw-text-sm);
}

.mndw-upload__success {
  color: var(--mndw-success, var(--mndw-text));
}
</style>
