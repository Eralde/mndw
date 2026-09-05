import {CUSTOM_ELEMENTS_SCHEMA, Component, inject, input, output} from '@angular/core';
import type {MndwCheckboxChangeDetail, MndwInputChangeDetail, MndwSelectChangeDetail} from '@mndw/ui';
import type {MwsNode} from '../../domain/mws/mws.types';
import type {MwsPortRole} from '../../api/mws-rci-write';
import {PRIMARY_SEGMENT_ID} from '../../api/node-edit-state';
import {type MwsWriteResult, MwsWriteService} from '../../services/mws-write.service';
import {type NodeEditDraft, type NodeSettingsSegment, NodeSettingsStore} from '../../services/node-settings.store';
import {TRANSLATOR} from '../../tokens';

interface SaveTask {
  field: string;
  run: () => Promise<MwsWriteResult>;
  commit: () => void;
}

function roleEquals(left: MwsPortRole | undefined, right: MwsPortRole | undefined): boolean {
  if (left === right) {
    return true;
  }

  return typeof left === 'object'
    && left !== null
    && typeof right === 'object'
    && right !== null
    && left.segment === right.segment;
}

function roleValue(role: MwsPortRole): string {
  if (typeof role === 'string') {
    return role;
  }

  return role.segment === PRIMARY_SEGMENT_ID ? 'primary' : `segment:${role.segment}`;
}

function parseRole(value: string): MwsPortRole {
  if (value === 'disabled' || value === 'primary') {
    return value;
  }

  return {segment: value.startsWith('segment:') ? value.slice('segment:'.length) : value};
}

function isValidIpv4(value: string): boolean {
  const octets = value.split('.');

  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255);
}

function hasFailedSave(result: MwsWriteResult): boolean {
  return result.steps.some((step) => step.step === 'save' && !step.ok);
}

@Component({
  selector: 'mws-node-settings',
  standalone: true,
  templateUrl: './node-settings.component.html',
  styleUrls: ['./node-settings.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class NodeSettingsComponent {
  private readonly translator = inject(TRANSLATOR);
  private readonly write = inject(MwsWriteService);
  protected readonly store = inject(NodeSettingsStore);

  public readonly node = input<MwsNode | null>(null);
  public readonly retryRequested = output<void>();
  public readonly reconcileRequested = output<void>();

  protected saving = false;
  protected saveSuccess = false;

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }

  protected draft(): NodeEditDraft | null {
    return this.store.draft();
  }

  protected segmentOptions(): NodeSettingsSegment[] {
    return this.store.segments();
  }

  protected portOptionValue(segmentId: string): string {
    return segmentId === PRIMARY_SEGMENT_ID ? 'primary' : `segment:${segmentId}`;
  }

  protected channelOptions(): string[] {
    const options = this.node()?.fwUpdateSandboxes.map((sandbox) => sandbox.name) ?? [];
    const current = this.draft()?.updateChannel;

    if (current !== null && current !== undefined && current !== '' && !options.includes(current)) {
      options.push(current);
    }

    return options;
  }

  protected portRole(port: number): string {
    const role = this.draft()?.portRoles.find((entry) => entry.port === port)?.role ?? 'primary';

    return roleValue(role);
  }

  protected fieldError(field: string): string | null {
    return this.store.fieldState(field).error;
  }

  protected fieldSucceeded(field: string): boolean {
    return this.store.fieldState(field).success;
  }

  protected fieldSaving(field: string): boolean {
    return this.store.fieldState(field).saving;
  }

  protected hasFieldErrors(): boolean {
    return Object.values(this.store.fieldStates()).some((state) => state.error !== null);
  }

  public saveChanges(): void {
    void this.save();
  }

  public cancelChanges(): void {
    this.reset();
  }

  public isSaving(): boolean {
    return this.saving;
  }

  protected onNameInput(event: CustomEvent<MndwInputChangeDetail>): void {
    this.store.setName(event.detail.value);
    this.clearStatus('name');
  }

  protected onStaticIpToggle(event: CustomEvent<MndwCheckboxChangeDetail>): void {
    this.store.setStaticIpEnabled(event.detail.checked);
    this.clearStatus('static-ip');
  }

  protected onStaticIpInput(event: CustomEvent<MndwInputChangeDetail>): void {
    this.store.setStaticIp(event.detail.value);
    this.clearStatus('static-ip');
  }

  protected onChannelChange(event: CustomEvent<MndwSelectChangeDetail>): void {
    const value = event.detail.value;

    this.store.setUpdateChannel(value === '' ? null : value);
    this.clearStatus('update-channel');
  }

  protected onPortChange(port: number, event: CustomEvent<MndwSelectChangeDetail>): void {
    this.store.setPortRole(port, parseRole(event.detail.value));
    this.clearStatus(`port-${port}`);
  }

  protected retry(): void {
    this.retryRequested.emit();
  }

  protected retryField(field: string): void {
    if (!this.saving && this.store.reconciliation() === 'idle') {
      void this.save(field);
    }
  }

  protected retryReconciliation(): void {
    this.store.retryReconciliation();
    this.reconcileRequested.emit();
  }

  protected reset(): void {
    if (!this.saving && this.store.reconciliation() === 'idle') {
      this.store.resetDraft();
      this.saveSuccess = false;
    }
  }

  public saveDisabled(): boolean {
    const draft = this.draft();

    return this.saving
      || draft === null
      || this.store.loadState() !== 'ready'
      || this.store.segmentsState() !== 'ready'
      || this.store.reconciliation() !== 'idle'
      || !this.store.hasChanges();
  }

  protected async save(onlyField?: string): Promise<void> {
    const node = this.node();
    const baseline = this.store.baseline();
    const draft = this.draft();

    if (node === null || baseline === null || draft === null || this.saveDisabled()) {
      return;
    }

    if (
      (onlyField === undefined || onlyField === 'static-ip')
      && draft.staticIpEnabled
      && !isValidIpv4(draft.staticIp ?? '')
    ) {
      this.store.fail('static-ip', this.t('edit-dialog.ip-invalid'));

      return;
    }

    this.saveSuccess = false;

    const tasks: SaveTask[] = [];
    const name = draft.name.trim();

    if ((onlyField === undefined || onlyField === 'name') && draft.name !== baseline.name) {
      tasks.push({
        field: 'name',
        run: () => this.write.setName(node.mac, name === '' ? null : name),
        commit: () => {
          this.store.setName(name);
          this.store.commit('name');
        },
      });
    }

    if (
      (onlyField === undefined || onlyField === 'static-ip')
      && (draft.staticIpEnabled !== baseline.staticIpEnabled || draft.staticIp !== baseline.staticIp)
    ) {
      const staticIp = draft.staticIp?.trim() ?? '';

      tasks.push({
        field: 'static-ip',
        run: () => this.write.setStaticIP(node.mac, draft.staticIpEnabled ? staticIp : undefined),
        commit: () => {
          this.store.setStaticIp(staticIp);
          this.store.commit('static-ip');
        },
      });
    }

    if (onlyField === undefined || onlyField === 'update-channel') {
      if (draft.updateChannel !== baseline.updateChannel) {
        tasks.push({
          field: 'update-channel',
          run: () => this.write.setUpdateChannel(node.mac, draft.updateChannel ?? undefined),
          commit: () => this.store.commit('update-channel'),
        });
      }
    }

    const baselineRoles = new Map(baseline.portRoles.map((entry) => [entry.port, entry.role]));
    const draftRoles = new Map(draft.portRoles.map((entry) => [entry.port, entry.role]));

    for (const port of node.ports) {
      const previous = baselineRoles.get(port.index) ?? 'primary';
      const next = draftRoles.get(port.index) ?? 'primary';

      if ((onlyField === undefined || onlyField === `port-${port.index}`) && !roleEquals(previous, next)) {
        tasks.push({
          field: `port-${port.index}`,
          run: () => this.write.setPortRole(node.mac, String(port.index), previous, next),
          commit: () => this.store.commit(`port-${port.index}`),
        });
      }
    }

    if (tasks.length === 0) {
      return;
    }

    this.saving = true;
    tasks.forEach((task) => this.store.markSaving(task.field));

    const results = await Promise.allSettled(tasks.map((task) => task.run()));
    const reconciliationFields: string[] = [];
    let failed = false;

    results.forEach((result, index) => {
      const task = tasks[index];

      if (task === undefined) {
        return;
      }

      if (result.status === 'fulfilled' && result.value.ok) {
        task.commit();

        return;
      }

      failed = true;

      const message = result.status === 'fulfilled'
        ? this.writeError(result.value, task.field)
        : result.reason instanceof Error
        ? result.reason.message
        : this.t('edit-dialog.save-partial');

      this.store.fail(task.field, message);

      if (result.status === 'fulfilled' && hasFailedSave(result.value)) {
        reconciliationFields.push(task.field);
      }
    });

    this.saving = false;
    this.saveSuccess = !failed && !this.hasFieldErrors();

    if (reconciliationFields.length > 0) {
      this.store.beginReconciliation(reconciliationFields);
      this.reconcileRequested.emit();
    }
  }

  private clearStatus(field: string): void {
    this.store.clearField(field);
    this.saveSuccess = false;
  }

  private writeError(result: MwsWriteResult, field: string): string {
    const message = result.steps
      .flatMap((step) => step.status)
      .find((status) => status.status === 'error' && status.message.trim() !== '')?.message;

    return message ?? this.t('edit-dialog.field-error', {field});
  }
}
