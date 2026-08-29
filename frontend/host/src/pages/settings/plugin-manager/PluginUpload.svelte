<script lang="ts">
import {onDestroy} from 'svelte';

import {
  type UploadResult,
  messageForError,
} from '../../../services/mgmt-client.js';
import {hostT} from '../../../services/host-i18n.svelte.js';
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {openApprovalModal} from './approval-modal.js';
import {
  type UploadTargetMismatch,
  validateExampleUploadTarget,
} from './upload-target.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type UploadStatus = 'idle' | 'uploading' | 'busy' | 'success' | 'error';
type ApprovalDecision = 'approve' | 'deny' | undefined;

interface ApprovalOutcome {
  decision: ApprovalDecision;
  aborted: boolean;
}

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

let status = $state<UploadStatus>('idle');
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
    return hostT('settings.plugin-manager.choose-zip');
  }

  if (file.size === 0) {
    return hostT('settings.plugin-manager.empty-zip');
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return hostT('settings.plugin-manager.zip-too-large');
  }
}

function uploadTargetMessage(mismatch: UploadTargetMismatch): string {
  return hostT(
    'settings.plugin-manager.upload-target-mismatch',
    {
      filename: mismatch.filename,
      archiveTarget: mismatch.archiveTarget,
      deviceTarget: mismatch.deviceTarget,
    },
  );
}

function validationErrorFor(file: File): string | undefined {
  const fileError = validate(file);

  if (fileError) {
    return fileError;
  }

  const targetMismatch = validateExampleUploadTarget(file.name, architecture);

  if (targetMismatch !== undefined) {
    return uploadTargetMessage(targetMismatch);
  }
}

function showError(message: string): void {
  error = message;
  status = 'error';
}

function markInstalled(entry: PluginListEntry): void {
  success = hostT(
    'settings.plugin-manager.installed-success',
    {
      label: entry.label,
    },
  );

  status = 'success';
  onInstalled();
}

async function requestApproval(
  entry: PluginListEntry,
): Promise<ApprovalOutcome> {
  const controller = new AbortController();

  approvalController = controller;

  try {
    const decision = await openApproval(entry, controller.signal);

    return {
      decision,
      aborted: controller.signal.aborted,
    };
  } finally {
    if (approvalController === controller) {
      approvalController = undefined;
    }
  }
}

async function resolvePending(
  entry: PluginListEntry,
  decision: ApprovalDecision,
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

    success = hostT(
      'settings.plugin-manager.approved-success',
      {
        label: entry.label,
      },
    );

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

  const validationError = validationErrorFor(file);

  if (validationError) {
    showError(validationError);

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

    showError(messageForError(caught));

    return;
  }

  if (destroyed) {
    return;
  }

  if (result.status === 'installed') {
    markInstalled(result.entry);

    return;
  }

  status = 'busy';

  let approval: ApprovalOutcome;

  try {
    approval = await requestApproval(result.entry);
  } catch (caught) {
    if (destroyed) {
      return;
    }

    showError(messageForError(caught));

    return;
  }

  if (destroyed || approval.aborted) {
    return;
  }

  await resolvePending(result.entry, approval.decision);
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
    <span>{hostT('settings.plugin-manager.upload-drop')}</span>
  </label>

  {#if status === 'uploading'}
    <p
      class="mndw-upload__status"
      role="status"
    >
      {hostT('settings.plugin-manager.uploading')}
    </p>
  {:else if status === 'busy'}
    <p
      class="mndw-upload__status"
      role="status"
    >
      {hostT('settings.plugin-manager.waiting-approval')}
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
