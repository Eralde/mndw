import {Injectable, signal} from '@angular/core';
import type {MwsPortRole} from '../api/mws-rci-write';
import type {NodeEditPortRole, NodeEditSegment, NodeEditState as ParsedNodeEditState} from '../api/node-edit-state';

export type NodeEditState = ParsedNodeEditState;

export interface NodeEditDraft extends NodeEditState {
  name: string;
}

export type NodeSettingsSegment = NodeEditSegment;

export interface NodeSettingsFieldState {
  saving: boolean;
  error: string | null;
  success: boolean;
}

export type NodeSettingsLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type NodeSettingsSegmentsState = 'idle' | 'loading' | 'ready' | 'error';
export type NodeSettingsReconciliationState = 'idle' | 'loading' | 'error';

const INITIAL_FIELD_STATE: NodeSettingsFieldState = {saving: false, error: null, success: false};

function cloneRole(role: MwsPortRole): MwsPortRole {
  return typeof role === 'string' ? role : {segment: role.segment};
}

function clonePortRoles(roles: readonly NodeEditPortRole[]): NodeEditPortRole[] {
  return roles.map((entry) => ({port: entry.port, role: cloneRole(entry.role)}));
}

function cloneDraft(draft: NodeEditDraft): NodeEditDraft {
  return {
    name: draft.name,
    staticIpEnabled: draft.staticIpEnabled,
    staticIp: draft.staticIp,
    updateChannel: draft.updateChannel,
    portRoles: clonePortRoles(draft.portRoles),
  };
}

function sameRole(left: MwsPortRole | undefined, right: MwsPortRole | undefined): boolean {
  if (left === right) {
    return true;
  }

  return typeof left === 'object'
    && left !== null
    && typeof right === 'object'
    && right !== null
    && left.segment === right.segment;
}

function sameDraft(left: NodeEditDraft, right: NodeEditDraft): boolean {
  if (
    left.name !== right.name
    || left.staticIpEnabled !== right.staticIpEnabled
    || left.staticIp !== right.staticIp
    || left.updateChannel !== right.updateChannel
    || left.portRoles.length !== right.portRoles.length
  ) {
    return false;
  }

  const rightRoles = new Map(right.portRoles.map((entry) => [entry.port, entry.role]));

  return left.portRoles.every((entry) => sameRole(entry.role, rightRoles.get(entry.port)));
}

function updateDraftField(draft: NodeEditDraft, field: string, source: NodeEditDraft): NodeEditDraft {
  if (field === 'name') {
    return {...draft, name: source.name};
  }

  if (field === 'static-ip') {
    return {...draft, staticIpEnabled: source.staticIpEnabled, staticIp: source.staticIp};
  }

  if (field === 'update-channel') {
    return {...draft, updateChannel: source.updateChannel};
  }

  if (field.startsWith('port-')) {
    const port = Number(field.slice('port-'.length));
    const sourceRole = source.portRoles.find((entry) => entry.port === port);

    return {
      ...draft,
      portRoles: sourceRole === undefined
        ? draft.portRoles
        : draft.portRoles.some((entry) => entry.port === port)
        ? draft.portRoles.map((entry) => entry.port === port ? {port, role: cloneRole(sourceRole.role)} : entry)
        : [...draft.portRoles, {port, role: cloneRole(sourceRole.role)}].sort((left, right) => left.port - right.port),
    };
  }

  return draft;
}

@Injectable()
export class NodeSettingsStore {
  public readonly baseline = signal<NodeEditDraft | null>(null);
  public readonly draft = signal<NodeEditDraft | null>(null);
  public readonly segments = signal<NodeSettingsSegment[]>([]);
  public readonly loadState = signal<NodeSettingsLoadState>('idle');
  public readonly loadError = signal<string | null>(null);
  public readonly segmentsState = signal<NodeSettingsSegmentsState>('idle');
  public readonly fieldStates = signal<Record<string, NodeSettingsFieldState>>({});
  public readonly reconciliation = signal<NodeSettingsReconciliationState>('idle');
  public readonly reconciliationError = signal<string | null>(null);
  private reconciliationFields = new Map<string, NodeEditDraft>();

  public initialize(name: string, state: NodeEditState, segments: readonly NodeSettingsSegment[]): void {
    const initial: NodeEditDraft = {
      name,
      staticIpEnabled: state.staticIpEnabled,
      staticIp: state.staticIp,
      updateChannel: state.updateChannel,
      portRoles: clonePortRoles(state.portRoles),
    };

    this.baseline.set(cloneDraft(initial));
    this.draft.set(cloneDraft(initial));
    this.segments.set(segments.map((segment) => ({...segment})));
    this.loadState.set('ready');
    this.loadError.set(null);
    this.segmentsState.set('ready');
    this.fieldStates.set({});
    this.reconciliation.set('idle');
    this.reconciliationError.set(null);
  }

  public beginLoad(): void {
    this.loadState.set('loading');
    this.loadError.set(null);
    this.segmentsState.set('loading');
  }

  public failLoad(message: string): void {
    this.loadState.set('error');
    this.loadError.set(message);
    this.segmentsState.set('error');
  }

  public setName(name: string): void {
    this.updateDraft((draft) => ({...draft, name}));
  }

  public setStaticIpEnabled(enabled: boolean): void {
    this.updateDraft((draft) => ({...draft, staticIpEnabled: enabled}));
  }

  public setStaticIp(ip: string): void {
    this.updateDraft((draft) => ({...draft, staticIp: ip}));
  }

  public setUpdateChannel(channel: string | null): void {
    this.updateDraft((draft) => ({...draft, updateChannel: channel}));
  }

  public setPortRole(port: number, role: MwsPortRole): void {
    this.updateDraft((draft) => ({
      ...draft,
      portRoles: draft.portRoles.some((entry) => entry.port === port)
        ? draft.portRoles.map((entry) => entry.port === port ? {port, role: cloneRole(role)} : entry)
        : [...draft.portRoles, {port, role: cloneRole(role)}].sort((left, right) => left.port - right.port),
    }));
  }

  public hasChanges(): boolean {
    const baseline = this.baseline();
    const draft = this.draft();

    return baseline !== null && draft !== null && !sameDraft(baseline, draft);
  }

  public fieldDirty(field: string): boolean {
    const baseline = this.baseline();
    const draft = this.draft();

    if (baseline === null || draft === null) {
      return false;
    }

    return !sameDraft(updateDraftField(cloneDraft(baseline), field, draft), baseline)
      || !sameDraft(updateDraftField(cloneDraft(draft), field, baseline), draft);
  }

  public fieldState(field: string): NodeSettingsFieldState {
    return this.fieldStates()[field] ?? INITIAL_FIELD_STATE;
  }

  public markSaving(field: string): void {
    this.setFieldState(field, {saving: true, error: null, success: false});
  }

  public commit(field: string): void {
    const baseline = this.baseline();
    const draft = this.draft();

    if (baseline === null || draft === null) {
      return;
    }

    this.baseline.set(updateDraftField(cloneDraft(baseline), field, draft));
    this.setFieldState(field, {saving: false, error: null, success: true});
  }

  public fail(field: string, error: string): void {
    this.setFieldState(field, {saving: false, error, success: false});
  }

  public clearField(field: string): void {
    this.setFieldState(field, INITIAL_FIELD_STATE);
  }

  public resetDraft(): void {
    const baseline = this.baseline();

    if (baseline === null || this.reconciliation() !== 'idle') {
      return;
    }

    this.draft.set(cloneDraft(baseline));
    this.fieldStates.set({});
  }

  public beginReconciliation(fields: readonly string[] = []): void {
    const draft = this.draft();

    this.reconciliationFields = draft === null
      ? new Map()
      : new Map(fields.map((field) => [field, cloneDraft(draft)]));
    this.reconciliation.set('loading');
    this.reconciliationError.set(null);
  }

  public reconcile(name: string, state: NodeEditState, segments: readonly NodeSettingsSegment[]): void {
    const baseline = this.baseline();
    const draft = this.draft();

    if (baseline === null || draft === null) {
      this.endReconciliation('No settings baseline is available.');

      return;
    }

    const confirmed: NodeEditDraft = {
      name,
      staticIpEnabled: state.staticIpEnabled,
      staticIp: state.staticIp,
      updateChannel: state.updateChannel,
      portRoles: clonePortRoles(state.portRoles),
    };
    let nextBaseline = cloneDraft(baseline);
    let nextDraft = cloneDraft(draft);
    let allConfirmed = true;

    for (const [field, requested] of this.reconciliationFields) {
      if (sameDraft(updateDraftField(cloneDraft(confirmed), field, requested), confirmed)) {
        nextBaseline = updateDraftField(nextBaseline, field, confirmed);
        nextDraft = updateDraftField(nextDraft, field, confirmed);
        this.setFieldState(field, {saving: false, error: null, success: true});
      } else {
        allConfirmed = false;
      }
    }

    this.baseline.set(nextBaseline);
    this.draft.set(nextDraft);
    this.segments.set(segments.map((segment) => ({...segment})));
    this.loadState.set('ready');
    this.segmentsState.set('ready');
    this.reconciliationFields = new Map();
    this.endReconciliation(allConfirmed ? null : 'The device did not confirm every requested setting.');
  }

  public endReconciliation(error: string | null = null): void {
    this.reconciliation.set(error === null ? 'idle' : 'error');
    this.reconciliationError.set(error);
  }

  public retryReconciliation(): void {
    if (this.reconciliation() === 'error') {
      this.reconciliation.set('loading');
      this.reconciliationError.set(null);
    }
  }

  private updateDraft(update: (draft: NodeEditDraft) => NodeEditDraft): void {
    const draft = this.draft();

    if (draft !== null) {
      this.draft.set(update(cloneDraft(draft)));
    }
  }

  private setFieldState(field: string, state: NodeSettingsFieldState): void {
    this.fieldStates.update((states) => ({...states, [field]: state}));
  }
}
