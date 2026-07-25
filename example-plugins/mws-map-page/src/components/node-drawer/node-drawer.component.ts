import {Component, Input} from '@angular/core';
import type {MwsNode} from '../../domain/mws/mws.types';

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
    const system = node.system;

    if (
      system?.memoryUsed === null || system?.memoryUsed === undefined
      || system?.memoryTotal === null || system?.memoryTotal === undefined
    ) {
      return '—';
    }

    return `${system.memoryUsed} / ${system.memoryTotal}`;
  }

  protected isWirelessBackhaul(node: MwsNode): boolean {
    return node.backhaul !== null && node.backhaul.ap !== null;
  }
}
