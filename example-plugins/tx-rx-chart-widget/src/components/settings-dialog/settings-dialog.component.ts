import {Component, input, output} from '@angular/core';
import type {NetworkInterface} from '../../types/rci.types';

/**
 * Settings form body. Rendered inside a host-managed overlay shell (see open-settings-dialog.ts).
 */
@Component({
  selector: 'tx-rx-settings-dialog',
  templateUrl: './settings-dialog.component.html',
  styleUrls: ['./settings-dialog.component.scss'],
})
export class SettingsDialogComponent {
  public readonly interfaces = input.required<NetworkInterface[]>();
  public readonly selectedInterface = input.required<string>();
  public readonly refresh = input.required<number>();
  public readonly interfaceChange = output<string>();
  public readonly refreshChange = output<number>();
  public readonly closeDialogEvent = output<void>();

  protected onRefreshChange(value: string): void {
    this.refreshChange.emit(Number(value));
  }
}
