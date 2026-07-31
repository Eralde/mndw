import {Component, Input} from '@angular/core';
import type {MwsNode} from '../../domain/mws/mws.types';
import {formatCpuLoad, formatMemory, formatRate, formatRssi, formatSpeed, formatUptime} from '../../format';

@Component({
  selector: 'mws-map-node-drawer',
  standalone: true,
  templateUrl: './node-drawer.component.html',
  styleUrls: ['./node-drawer.component.scss'],
})
export class NodeDrawerComponent {
  @Input()
  public node: MwsNode | null = null;

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
