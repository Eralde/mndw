import {CUSTOM_ELEMENTS_SCHEMA, Component, EventEmitter, Input, Output, inject} from '@angular/core';
import type {MwsNode, MwsRadioPower} from '../../domain/mws/mws.types';
import {formatCpuLoad, formatMemory, formatRate, formatRssi, formatSpeed, formatUptime} from '../../format';
import {MwsDataService} from '../../services/mws-data.service';
import {type MwsWriteResult, MwsWriteService} from '../../services/mws-write.service';
import {MWS_RENAME_API, type MwsRenameApi} from '../../tokens';
import {validateNodeName} from '../../api/node-name';

export type MwsWifiInterface = 'WifiMaster0' | 'WifiMaster1';

interface PowerControlState {
  lastObserved: MwsRadioPower;
  baseline: MwsRadioPower | null;
  optimistic: number | null;
  pending: boolean;
}

const UNAVAILABLE_POWER: MwsRadioPower = {value: null, available: false};

@Component({
  selector: 'mws-map-node-drawer',
  standalone: true,
  templateUrl: './node-drawer.component.html',
  styleUrls: ['./node-drawer.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class NodeDrawerComponent {
  private readonly renameApi = inject<MwsRenameApi>(MWS_RENAME_API);
  private readonly data = inject(MwsDataService);
  private readonly write = inject(MwsWriteService);

  private nodeValue: MwsNode | null = null;
  private observedMac: string | null = null;
  private readonly powerState: Record<MwsWifiInterface, PowerControlState> = {
    WifiMaster0: this.newPowerControl(),
    WifiMaster1: this.newPowerControl(),
  };

  @Input()
  public set node(value: MwsNode | null) {
    if (this.observedMac !== value?.mac) {
      this.resetPowerControls();
      this.observedMac = value?.mac ?? null;
    }

    this.nodeValue = value;
    this.observePower(value);
  }

  public get node(): MwsNode | null {
    return this.nodeValue;
  }

  @Input()
  public setTitle: (title: string) => void = () => undefined;

  @Output()
  public readonly renamed = new EventEmitter<string>();

  protected editing = false;
  protected draft = '';
  protected pending = false;
  protected error = '';
  protected powerError = '';

  protected beginRename(): void {
    if (this.node === null || this.pending) {
      return;
    }

    this.draft = this.node.name;
    this.error = '';
    this.editing = true;
  }

  protected cancelRename(): void {
    if (this.pending) {
      return;
    }

    this.editing = false;
    this.error = '';
  }

  protected onNameInput(event: CustomEvent<{value: string}>): void {
    this.draft = event.detail.value;
    this.error = '';
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
    if (this.pending || this.node === null) {
      return;
    }

    const validation = validateNodeName(this.draft);

    if (validation.value === null) {
      this.error = validation.error ?? 'Invalid name.';

      return;
    }

    const name = validation.value;
    const node = this.node;

    this.pending = true;
    this.error = '';

    this.renameApi.renameNode(node.mac, node.isController, name).subscribe({
      next: () => {
        this.pending = false;
        this.editing = false;
        this.renamed.emit(name);
        this.setTitle(name);
        this.data.refreshNow();
      },
      error: (error: unknown) => {
        this.pending = false;
        this.error = error instanceof Error ? error.message : 'Rename failed.';
      },
    });
  }

  protected dash(value: string | number | null | undefined): string {
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  protected memory(node: MwsNode): string {
    return formatMemory(node.system?.memoryUsed, node.system?.memoryTotal);
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

    return power.available ? String(this.powerValue(node, interfaceName)) : 'Unavailable';
  }

  protected powerDisabled(node: MwsNode, interfaceName: MwsWifiInterface): boolean {
    const power = this.powerFor(node, interfaceName);
    const state = this.powerState[interfaceName];

    return !power.available || state.pending || node.persistentSession !== true;
  }

  protected onPowerChange(node: MwsNode, interfaceName: MwsWifiInterface, event: CustomEvent<{value: number}>): void {
    const power = this.powerFor(node, interfaceName);
    const state = this.powerState[interfaceName];
    const cid = node.cid;

    if (node.isController || cid === null || node.persistentSession !== true || !power.available || state.pending) {
      return;
    }

    state.baseline = this.copyPower(state.lastObserved);
    state.optimistic = event.detail.value;
    state.pending = true;
    this.powerError = '';

    void this.write.setPower(cid, interfaceName, event.detail.value, true)
      .then((result) => {
        if (!result.ok) {
          this.failPowerWrite(interfaceName, this.writeError(result));

          return;
        }

        state.pending = false;
      })
      .then(undefined, (error: unknown) => {
        this.failPowerWrite(interfaceName, error instanceof Error ? error.message : 'TX power update failed.');
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
    this.powerError = '';
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

  private failPowerWrite(interfaceName: MwsWifiInterface, message: string): void {
    const state = this.powerState[interfaceName];

    state.pending = false;
    state.optimistic = null;
    state.baseline = null;
    this.powerError = message;
  }

  private writeError(result: MwsWriteResult): string {
    for (const step of result.steps) {
      for (const status of step.status) {
        if (status.message !== '') {
          return status.message;
        }
      }
    }

    return 'TX power update failed.';
  }

  private copyPower(power: MwsRadioPower): MwsRadioPower {
    return {value: power.value, available: power.available};
  }

  private samePower(left: MwsRadioPower | null, right: MwsRadioPower | null): boolean {
    return left?.value === right?.value && left?.available === right?.available;
  }
}
