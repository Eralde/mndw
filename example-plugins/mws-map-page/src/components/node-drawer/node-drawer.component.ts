import {CUSTOM_ELEMENTS_SCHEMA, Component, EventEmitter, Input, Output, inject} from '@angular/core';
import type {MwsNode} from '../../domain/mws/mws.types';
import {formatCpuLoad, formatMemory, formatRate, formatRssi, formatSpeed, formatUptime} from '../../format';
import {MwsDataService} from '../../services/mws-data.service';
import {MWS_RENAME_API, type MwsRenameApi} from '../../tokens';
import {validateNodeName} from '../../api/node-name';

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

  @Input()
  public node: MwsNode | null = null;

  @Input()
  public setTitle: (title: string) => void = () => undefined;

  @Output()
  public readonly renamed = new EventEmitter<string>();

  protected editing = false;
  protected draft = '';
  protected pending = false;
  protected error = '';

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

  protected isWirelessBackhaul(node: MwsNode): boolean {
    return node.backhaul !== null && node.backhaul.ap !== null;
  }
}
