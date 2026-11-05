import type {PluginRciManager} from '@mndw/sdk';
import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  type OnDestroy,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import type {MndwChartSample} from '@mndw/ui';
import {RciResponseHelper} from '@rci-tools/core';
import {firstValueFrom, fromEvent, takeUntil} from 'rxjs';
import {normalizeBridgeSegments, parseNodeEditState} from '../../api/node-edit-state';
import type {MwsNode, MwsRadioPower, MwsUtilSeries} from '../../domain/mws/mws.types';
import {formatCpuLoad, formatMemory, formatRate, formatRssi, formatSpeed, formatUptime} from '../../format';
import {MwsDataService} from '../../services/mws-data.service';
import {NodeSettingsComponent} from '../node-settings/node-settings.component';
import {NodeSettingsStore} from '../../services/node-settings.store';
import {type MwsWriteResult, MwsWriteService} from '../../services/mws-write.service';
import {MWS_RENAME_API, type MwsRenameApi, RCI_MANAGER, TRANSLATOR} from '../../tokens';
import {type NodeNameValidationErrorCode, validateNodeName} from '../../api/node-name';
import {type NodeStatusLabels, getNodeStatusLabels, getPowerDisabledHint} from '../../status-labels';

export type MwsWifiInterface = 'WifiMaster0' | 'WifiMaster1';

/** How a metric's history is drawn: magnitude bars (CPU/RAM) or a color heatmap (Wi-Fi). */
export type UtilizationChartKind = 'bars' | 'heat';

/** One labeled row in the drawer's live-telemetry panel. */
export interface UtilizationMetric {
  readonly key: string;
  readonly label: string;
  readonly percent: number | null;
  readonly valueText: string;
  readonly points: readonly MndwChartSample[];
  readonly kind: UtilizationChartKind;
}

interface PowerControlState {
  lastObserved: MwsRadioPower;
  baseline: MwsRadioPower | null;
  optimistic: number | null;
  pending: boolean;
}

const UNAVAILABLE_POWER: MwsRadioPower = {value: null, available: false};

function responseRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responseErrorMessage(value: unknown): string | null {
  const source = responseRecord(value);

  if (source === null) {
    return null;
  }

  for (const error of Object.values(RciResponseHelper.getErrors(source))) {
    if (error.message.trim() !== '') {
      return error.message;
    }
  }

  return null;
}

function hasResponseShape(value: unknown, keys: readonly string[]): boolean {
  if (Array.isArray(value)) {
    return true;
  }

  const source = responseRecord(value);

  if (source === null || keys.some((key) => key in source)) {
    return source !== null;
  }

  return Object.values(source).every((entry) => responseRecord(entry) !== null);
}

type ErrorTranslationKey =
  | 'error.invalid-name'
  | 'error.name-empty'
  | 'error.name-too-long'
  | 'error.rename-failed';

const NODE_NAME_ERROR_KEYS: Record<NodeNameValidationErrorCode, Exclude<ErrorTranslationKey, 'error.invalid-name'>> = {
  'empty': 'error.name-empty',
  'too-long': 'error.name-too-long',
};

@Component({
  selector: 'mws-map-node-drawer',
  standalone: true,
  templateUrl: './node-drawer.component.html',
  styleUrls: ['./node-drawer.component.scss'],
  imports: [NodeSettingsComponent],
  providers: [NodeSettingsStore],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class NodeDrawerComponent implements OnDestroy {
  private readonly translator = inject(TRANSLATOR);
  private readonly renameApi = inject<MwsRenameApi>(MWS_RENAME_API);
  private readonly data = inject(MwsDataService);
  private readonly write = inject(MwsWriteService);
  private readonly rci = inject<PluginRciManager>(RCI_MANAGER);
  protected readonly settingsStore = inject(NodeSettingsStore);
  private readonly nodeSettings = viewChild(NodeSettingsComponent);

  private observedMac: string | null = null;
  private settingsMac: string | null = null;
  private settingsGeneration = 0;
  private settingsAbortController: AbortController | null = null;
  private readonly powerState: Record<MwsWifiInterface, PowerControlState> = {
    WifiMaster0: this.newPowerControl(),
    WifiMaster1: this.newPowerControl(),
  };

  public readonly node = input<MwsNode | null>(null);
  public readonly setTitle = input<(title: string) => void>(() => undefined);
  public readonly renamed = output<string>();
  private observedNode: MwsNode | null | undefined;

  protected selectedTab = 'status';
  protected editing = false;
  protected draft = '';
  protected pending = false;
  protected error = '';
  protected powerError = '';
  protected webPanelPending = false;
  protected webPanelError = '';
  private renameErrorKey: ErrorTranslationKey | null = null;
  private powerErrorKey: 'error.tx-power-failed' | null = null;
  private renameStartName: string | null = null;

  public constructor() {
    effect(() => {
      this.observeSettings(this.node());
    });
  }

  protected currentNode(): MwsNode | null {
    const node = this.node();

    if (this.observedNode === node) {
      return node;
    }

    if (this.observedMac !== node?.mac) {
      this.resetPowerControls();
      this.observedMac = node?.mac ?? null;
    }

    this.observedNode = node;
    this.observePower(node);

    return node;
  }

  protected onTabChanged(event: CustomEvent<{value?: string}>): void {
    const value = event.detail?.value;

    if (value === 'status' || value === 'settings' || value === 'clients') {
      this.selectedTab = value;
    }
  }

  protected displayName(node: MwsNode): string {
    return node.isController ? node.name : this.settingsStore.draft()?.name ?? node.name;
  }

  private observeSettings(node: MwsNode | null): void {
    if (node === null || node.isController) {
      if (this.settingsMac !== node?.mac) {
        this.cancelSettingsLoad();
        this.settingsMac = node?.mac ?? null;
        this.selectedTab = 'status';
      }

      return;
    }

    if (this.settingsMac !== node.mac) {
      this.startSettingsLoad(node);
    }
  }

  private startSettingsLoad(node: MwsNode): void {
    this.cancelSettingsLoad();
    this.settingsMac = node.mac;
    this.selectedTab = 'status';
    this.settingsStore.beginLoad();

    const controller = new AbortController();
    const generation = this.settingsGeneration;

    this.settingsAbortController = controller;
    void this.loadSettings(node, generation, controller.signal, false);
  }

  private async loadSettings(
    node: MwsNode,
    generation: number,
    signal: AbortSignal,
    reconciliation: boolean,
  ): Promise<void> {
    try {
      const responses = await firstValueFrom(
        this.rci.queue([
          {path: 'show.sc.ip.dhcp.host'},
          {path: 'show.sc.mws.member'},
          {path: 'show.sc.interface'},
          {path: 'show.interface'},
        ]).pipe(takeUntil(fromEvent(signal, 'abort'))),
        {defaultValue: undefined},
      );

      if (!this.isCurrentSettings(node, generation, signal)) {
        return;
      }

      if (!Array.isArray(responses) || responses.length < 4) {
        throw new Error(this.t('edit-dialog.segments-error'));
      }

      const dhcp = responses[0];
      const member = responses[1];
      const interfaceConfig = responses[2];
      const showInterfaces = responses[3];

      if (
        dhcp === undefined
        || member === undefined
        || interfaceConfig === undefined
        || showInterfaces === undefined
        || RciResponseHelper.hasErrors(dhcp)
        || RciResponseHelper.hasErrors(member)
        || RciResponseHelper.hasErrors(interfaceConfig)
        || RciResponseHelper.hasErrors(showInterfaces)
      ) {
        throw new Error(
          responseErrorMessage(dhcp) ?? responseErrorMessage(member) ?? responseErrorMessage(interfaceConfig)
            ?? responseErrorMessage(showInterfaces)
            ?? this.t('edit-dialog.segments-error'),
        );
      }

      if (
        !hasResponseShape(dhcp, ['host'])
        || !hasResponseShape(member, ['member'])
        || !hasResponseShape(interfaceConfig, ['interface'])
        || !hasResponseShape(showInterfaces, ['interface', 'id', 'type'])
      ) {
        throw new Error(this.t('edit-dialog.segments-error'));
      }

      const state = parseNodeEditState(dhcp, member, node.mac);
      const segments = normalizeBridgeSegments(interfaceConfig, showInterfaces);

      if (reconciliation) {
        this.settingsStore.reconcile(node.name, state, segments);
      } else {
        this.settingsStore.initialize(node.name, state, segments);

        if (this.editing) {
          this.settingsStore.setName(this.draft);
        }
      }

      this.settingsAbortController = null;
    } catch (error: unknown) {
      if (!this.isCurrentSettings(node, generation, signal)) {
        return;
      }

      const message = error instanceof Error ? error.message : this.t('edit-dialog.segments-error');

      if (reconciliation) {
        this.settingsStore.endReconciliation(message);
      } else {
        this.settingsStore.failLoad(message);
      }
    }
  }

  private isCurrentSettings(node: MwsNode, generation: number, signal: AbortSignal): boolean {
    return generation === this.settingsGeneration
      && !signal.aborted
      && this.settingsMac === node.mac
      && this.node()?.mac === node.mac
      && this.node()?.isController === false;
  }

  protected beginRename(): void {
    const node = this.node();

    if (node === null || this.pending) {
      return;
    }

    this.draft = node.isController ? node.name : this.settingsStore.draft()?.name ?? node.name;
    this.renameStartName = this.draft;

    if (!node.isController && this.settingsStore.draft() !== null) {
      this.settingsStore.setName(this.draft);
    }

    this.clearRenameError();
    this.editing = true;
  }

  protected cancelRename(): void {
    if (this.pending) {
      return;
    }

    if (!this.node()?.isController && this.renameStartName !== null) {
      this.settingsStore.setName(this.renameStartName);
    }

    this.editing = false;
    this.renameStartName = null;
    this.clearRenameError();
  }

  protected onNameInput(event: CustomEvent<{value: string}>): void {
    this.draft = event.detail.value;

    if (!this.node()?.isController) {
      this.settingsStore.setName(this.draft);
    }

    this.clearRenameError();
  }

  protected onNameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelRename();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.saveRename();
    }
  }

  protected saveRename(): void {
    const node = this.node();

    if (this.pending || node === null) {
      return;
    }

    const validation = validateNodeName(this.draft);

    if (validation.value === null) {
      this.error = '';
      this.renameErrorKey = validation.errorCode === null
        ? 'error.invalid-name'
        : NODE_NAME_ERROR_KEYS[validation.errorCode];

      return;
    }

    const name = validation.value;

    this.pending = true;
    this.clearRenameError();

    if (node.isController) {
      this.renameApi.renameNode(node.mac, true, name).subscribe({
        next: () => this.completeRename(name),
        error: (error: unknown) => this.failRename(error),
      });

      return;
    }

    void this.write.setName(node.mac, name)
      .then((result) => {
        if (!result.ok) {
          throw new Error(this.writeError(result) ?? this.t('error.rename-failed'));
        }

        this.completeRename(name);
      })
      .catch((error: unknown) => this.failRename(error));
  }

  protected retrySettings(): void {
    const node = this.node();

    if (node !== null && !node.isController) {
      this.startSettingsLoad(node);
    }
  }

  protected settingsSaveDisabled(): boolean {
    return this.nodeSettings()?.saveDisabled() ?? true;
  }

  protected settingsSaving(): boolean {
    return this.nodeSettings()?.isSaving() ?? false;
  }

  protected saveSettings(): void {
    this.nodeSettings()?.saveChanges();
  }

  protected cancelSettings(): void {
    this.nodeSettings()?.cancelChanges();
  }

  protected reconcileSettings(): void {
    const node = this.node();

    if (node === null || node.isController) {
      return;
    }

    this.cancelSettingsLoad();

    const controller = new AbortController();
    const generation = this.settingsGeneration;

    this.settingsAbortController = controller;
    void this.loadSettings(node, generation, controller.signal, true);
  }

  private completeRename(name: string): void {
    this.pending = false;
    this.editing = false;
    this.renameStartName = null;

    if (!this.node()?.isController && this.settingsStore.baseline() !== null) {
      this.settingsStore.setName(name);
      this.settingsStore.commit('name');
    }

    this.renamed.emit(name);
    this.setTitle()(name);
    this.data.refreshNow();
  }

  private failRename(error: unknown): void {
    this.pending = false;

    if (error instanceof Error) {
      this.error = error.message;
      this.renameErrorKey = null;
    } else {
      this.error = '';
      this.renameErrorKey = 'error.rename-failed';
    }
  }

  protected renameErrorMessage(): string {
    return this.renameErrorKey === null ? this.error : this.t(this.renameErrorKey);
  }

  protected canOpenWebPanel(node: MwsNode): boolean {
    return !node.isController && node.isOnline && node.cid !== null;
  }

  protected openWebPanel(node: MwsNode): void {
    if (!this.canOpenWebPanel(node) || this.webPanelPending || node.cid === null) {
      return;
    }

    const popup = window.open('about:blank', '_blank');

    if (popup === null) {
      this.webPanelError = this.t('drawer.popup-blocked');

      return;
    }

    popup.opener = null;
    this.webPanelPending = true;
    this.webPanelError = '';

    void this.renameApi.getAuthUrl(node.cid)
      .then((url) => {
        if (!popup.closed) {
          popup.location.href = url;
        }
      })
      .catch((error: unknown) => {
        if (!popup.closed) {
          popup.close();
        }

        this.webPanelError = error instanceof Error ? error.message : this.t('drawer.open-web-panel-failed');
      })
      .finally(() => {
        this.webPanelPending = false;
      });
  }

  protected dash(value: string | number | null | undefined): string {
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  protected memory(node: MwsNode): string {
    return formatMemory(node.system?.memoryUsed, node.system?.memoryTotal);
  }

  protected showUtilization(node: MwsNode): boolean {
    // Extenders show live telemetry once their persistent session is up; the
    // controller has no session but carries telemetry from direct RCI calls.
    return node.liveTelemetry !== undefined || (!node.isController && node.persistentSession === true);
  }

  protected utilizationMetrics(node: MwsNode): UtilizationMetric[] {
    const telemetry = node.liveTelemetry;
    const metrics: UtilizationMetric[] = [
      this.metric('cpu', this.t('drawer.util-cpu'), 'bars', this.clampPercent(node.system?.cpuload), telemetry?.cpu),
      this.metric('ram', this.t('drawer.util-ram'), 'bars', this.memoryPercent(node), telemetry?.memory),
      this.metric(
        'wifi24',
        this.t('drawer.util-wifi-24'),
        'heat',
        this.lastValue(telemetry?.wifi24.values),
        telemetry?.wifi24,
      ),
    ];

    if (node.dualBand || (telemetry?.wifi5.values.length ?? 0) > 0) {
      metrics.push(
        this.metric(
          'wifi5',
          this.t('drawer.util-wifi-5'),
          'heat',
          this.lastValue(telemetry?.wifi5.values),
          telemetry?.wifi5,
        ),
      );
    }

    return metrics;
  }

  private metric(
    key: string,
    label: string,
    kind: UtilizationChartKind,
    percent: number | null,
    series: MwsUtilSeries | undefined,
  ): UtilizationMetric {
    return {
      key,
      label,
      kind,
      percent,
      valueText: percent === null ? '—' : `${Math.round(percent)}%`,
      points: (series?.values ?? []).map((value, index) => {
        const time = series?.times[index];

        return time !== undefined && Number.isFinite(time) ? {time, value} : {value};
      }),
    };
  }

  private memoryPercent(node: MwsNode): number | null {
    const used = node.system?.memoryUsed;
    const total = node.system?.memoryTotal;

    if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) {
      return null;
    }

    return this.clampPercent((used / total) * 100);
  }

  private lastValue(history: readonly number[] | undefined): number | null {
    if (history === undefined || history.length === 0) {
      return null;
    }

    return this.clampPercent(history[history.length - 1]);
  }

  private clampPercent(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    return Math.min(Math.max(value, 0), 100);
  }

  protected statusLabels(node: MwsNode): NodeStatusLabels {
    return getNodeStatusLabels(node, (key, values) => this.t(key, values));
  }

  protected telemetryLastTelemetry(node: MwsNode): string | null {
    const lastTelemetryAt = node.mwsdStatus?.lastTelemetryAt;

    if (lastTelemetryAt === null || lastTelemetryAt === undefined) {
      return null;
    }

    const now = this.data.freshnessNow?.() ?? Date.now();
    const seconds = Math.max(0, Math.floor((now - lastTelemetryAt) / 1000));

    return this.t('drawer.telemetry-last-telemetry', {seconds});
  }

  protected uptime(value: number | null | undefined): string {
    return formatUptime(value);
  }

  protected cpuLoad(value: number | null | undefined): string {
    return formatCpuLoad(value);
  }

  protected rssi(value: number | null | undefined): string {
    return formatRssi(value);
  }

  protected rate(value: number | null | undefined): string {
    return formatRate(value);
  }

  protected speed(value: string | null | undefined): string {
    return formatSpeed(value);
  }

  protected powerValue(node: MwsNode, interfaceName: MwsWifiInterface): number {
    const state = this.powerState[interfaceName];

    return state.optimistic ?? this.powerFor(node, interfaceName).value ?? 100;
  }

  protected powerValueText(node: MwsNode, interfaceName: MwsWifiInterface): string {
    const power = this.powerFor(node, interfaceName);

    return power.available ? String(this.powerValue(node, interfaceName)) : this.t('drawer.unavailable');
  }

  protected powerDisabled(node: MwsNode, interfaceName: MwsWifiInterface): boolean {
    const power = this.powerFor(node, interfaceName);
    const state = this.powerState[interfaceName];

    return this.data.extraFeaturesAvailability() !== 'active'
      || !power.available || state.pending || node.persistentSession !== true;
  }

  protected powerDisabledHint(node: MwsNode, interfaceName: MwsWifiInterface): string | null {
    const power = this.powerFor(node, interfaceName);
    const state = this.powerState[interfaceName];

    return getPowerDisabledHint(
      this.data.extraFeaturesAvailability() === 'active',
      node,
      power.available,
      state.pending,
      (key, values) => this.t(key, values),
    );
  }

  protected onPowerChange(node: MwsNode, interfaceName: MwsWifiInterface, event: CustomEvent<{value: number}>): void {
    const power = this.powerFor(node, interfaceName);
    const state = this.powerState[interfaceName];
    const cid = node.cid;

    if (
      this.data.extraFeaturesAvailability() !== 'active'
      || node.isController || cid === null || node.persistentSession !== true || !power.available || state.pending
    ) {
      return;
    }

    state.baseline = this.copyPower(state.lastObserved);
    state.optimistic = event.detail.value;
    state.pending = true;
    this.clearPowerError();

    void this.write.setPower(cid, interfaceName, event.detail.value, true)
      .then((result) => {
        if (!result.ok) {
          const message = this.writeError(result);

          this.failPowerWrite(
            interfaceName,
            message ?? '',
            message === null ? 'error.tx-power-failed' : null,
          );

          return;
        }

        state.pending = false;
      })
      .then(undefined, (error: unknown) => {
        if (error instanceof Error) {
          this.failPowerWrite(interfaceName, error.message);
        } else {
          this.failPowerWrite(interfaceName, '', 'error.tx-power-failed');
        }
      });
  }

  protected isWirelessBackhaul(node: MwsNode): boolean {
    return node.backhaul !== null && node.backhaul.ap !== null;
  }

  private newPowerControl(): PowerControlState {
    return {lastObserved: this.copyPower(UNAVAILABLE_POWER), baseline: null, optimistic: null, pending: false};
  }

  private resetPowerControls(): void {
    this.powerState.WifiMaster0 = this.newPowerControl();
    this.powerState.WifiMaster1 = this.newPowerControl();
    this.clearPowerError();
  }

  private observePower(node: MwsNode | null): void {
    for (const interfaceName of ['WifiMaster0', 'WifiMaster1'] as const) {
      const state = this.powerState[interfaceName];
      const incoming = this.powerFor(node, interfaceName);

      state.lastObserved = this.copyPower(incoming);

      if (state.optimistic === null || state.pending || !incoming.available) {
        continue;
      }

      if (incoming.value === state.optimistic || !this.samePower(incoming, state.baseline)) {
        state.optimistic = null;
        state.baseline = null;
      }
    }
  }

  private powerFor(node: MwsNode | null, interfaceName: MwsWifiInterface): MwsRadioPower {
    const power = node?.wifiPower?.[interfaceName === 'WifiMaster0' ? 'power2g' : 'power5g'];

    return power === undefined ? UNAVAILABLE_POWER : power;
  }

  private failPowerWrite(
    interfaceName: MwsWifiInterface,
    message: string,
    errorKey: 'error.tx-power-failed' | null = null,
  ): void {
    const state = this.powerState[interfaceName];

    state.pending = false;
    state.optimistic = null;
    state.baseline = null;
    this.powerError = message;
    this.powerErrorKey = errorKey;
  }

  protected powerErrorMessage(): string {
    return this.powerErrorKey === null ? this.powerError : this.t(this.powerErrorKey);
  }

  private writeError(result: MwsWriteResult): string | null {
    for (const step of result.steps) {
      for (const status of step.status) {
        if (status.message !== '') {
          return status.message;
        }
      }
    }

    return null;
  }

  private clearRenameError(): void {
    this.error = '';
    this.renameErrorKey = null;
  }

  private clearPowerError(): void {
    this.powerError = '';
    this.powerErrorKey = null;
  }

  private copyPower(power: MwsRadioPower): MwsRadioPower {
    return {value: power.value, available: power.available};
  }

  private samePower(left: MwsRadioPower | null, right: MwsRadioPower | null): boolean {
    return left?.value === right?.value && left?.available === right?.available;
  }

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }

  public ngOnDestroy(): void {
    this.cancelSettingsLoad();
  }

  private cancelSettingsLoad(): void {
    this.settingsGeneration += 1;
    this.settingsAbortController?.abort();
    this.settingsAbortController = null;
  }
}
