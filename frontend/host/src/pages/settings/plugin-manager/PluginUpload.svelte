<script lang="ts">
import {onDestroy} from 'svelte';

import {MAX_UPLOAD_BYTES} from '../../../constants.js';
import {
  type UploadResult,
  messageForError,
} from '../../../services/mgmt-client.js';
import {toast} from '../../../services/toast/toast.svelte.js';
import {getUploadLimitLabel} from '../../../services/upload-limit.js';
import {getHostServices} from '../../../host-services-context.js';
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import InstallVersionWarnings from './InstallVersionWarnings.svelte';
import {openApprovalModal} from './approval-modal.js';
import {
  type UploadTargetMismatch,
  validateExampleUploadTarget,
} from './upload-target.js';

type UploadStatus = 'idle' | 'uploading' | 'busy' | 'success' | 'error';
type ApprovalDecision = 'approve' | 'deny' | undefined;

const PLUGIN_INSTALL_TOAST_KEY = 'settings.plugin-manager.install';
const PLUGIN_APPROVAL_TOAST_KEY = 'settings.plugin-manager.approval';

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
  openApproval: providedOpenApproval,
}: Props = $props();
const services = getHostServices();
const hostT = services.locale.hostT;

function openApproval(
  entry: PluginListEntry,
  signal?: AbortSignal,
): Promise<'approve' | 'deny' | undefined> {
  if (providedOpenApproval) {
    return providedOpenApproval(entry, signal);
  }

  return openApprovalModal(services, entry, signal);
}

function formatError(error: unknown): string {
  return messageForError(error, hostT, () => getUploadLimitLabel(hostT));
}

let status = $state<UploadStatus>('idle');
let error = $state('');
let installedEntry = $state<PluginListEntry | null>(null);
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
    return hostT('settings.plugin-manager.zip-too-large', {
      limit: getUploadLimitLabel(hostT),
    });
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
  installedEntry = entry;
  toast.success(
    hostT(
      'settings.plugin-manager.installed-success',
      {
        label: entry.label,
      },
    ),
    {key: PLUGIN_INSTALL_TOAST_KEY},
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

    toast.success(
      hostT(
        'settings.plugin-manager.approved-success',
        {
          label: entry.label,
        },
      ),
      {key: PLUGIN_APPROVAL_TOAST_KEY},
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

    showError(formatError(caught));

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

    showError(formatError(caught));

    return;
  }

  if (destroyed || approval.aborted) {
    return;
  }

  await resolvePending(result.entry, approval.decision);
}

function onInput(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];

  input.value = '';

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
  <div
    class="mndw-alert mndw-alert--warning mndw-plugin-risk-warning"
    role="note"
  >
    <p>{hostT('settings.plugin-risk-warning-intro')}</p>
    <p>{hostT('settings.plugin-risk-warning-page')}</p>
    <p>{hostT('settings.plugin-risk-warning-trust')}</p>
  </div>

  <label
    id="mndw-plugin-upload"
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
    {#if installedEntry}
      <InstallVersionWarnings lock={installedEntry.lock} />
    {/if}
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

.mndw-plugin-risk-warning > p {
  margin: 0;
}

.mndw-plugin-risk-warning > p + p {
  margin-top: var(--mndw-space-2);
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

.mndw-upload__status {
  margin: 0;
  font-size: var(--mndw-text-sm);
}
</style>
