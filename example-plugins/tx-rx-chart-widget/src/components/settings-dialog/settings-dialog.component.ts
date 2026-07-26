import {CUSTOM_ELEMENTS_SCHEMA, Component, EventEmitter, Input, Output} from '@angular/core';
import type {NetworkInterface} from '../../types/rci.types';
import {refreshMsToSeconds, refreshSecondsToMs} from '../../utils/refresh.utils';

/**
 * Settings form body. Rendered inside a host-managed overlay shell (see open-settings-dialog.ts).
 */
@Component({
  selector: 'tx-rx-settings-dialog',
  standalone: true,
  templateUrl: './settings-dialog.component.html',
  styleUrls: ['./settings-dialog.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class SettingsDialogComponent {
  @Input({required: true})
  public interfaces: NetworkInterface[] = [];

  @Input({required: true})
  public selectedInterface = '';

  @Input({required: true})
  public refresh = 3000;

  @Output()
  public readonly interfaceChange = new EventEmitter<string>();

  @Output()
  public readonly refreshChange = new EventEmitter<number>();

  @Output()
  public readonly closeDialogEvent = new EventEmitter<void>();

  protected readonly refreshMsToSeconds = refreshMsToSeconds;

  protected onRefreshChange(value: string): void {
    this.refresh = refreshSecondsToMs(value);
    this.refreshChange.emit(this.refresh);
  }
}
