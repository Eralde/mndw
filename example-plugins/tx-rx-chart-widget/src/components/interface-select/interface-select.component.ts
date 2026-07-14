import {Component, input, output} from '@angular/core';
import type {NetworkInterface} from '../../types/rci.types';

@Component({
  selector: 'tx-rx-interface-select',
  templateUrl: './interface-select.component.html',
  styleUrls: ['./interface-select.component.scss'],
})
export class InterfaceSelectComponent {
  public readonly interfaces = input.required<NetworkInterface[]>();
  public readonly selectedId = input.required<string>();
  public readonly selectedLabel = input<string>('');
  public readonly selectedChange = output<string>();

  protected open = false;

  protected toggleOpen(): void {
    this.open = !this.open;
  }

  protected onSelect(value: string): void {
    this.selectedChange.emit(value);
    this.open = false;
  }
}
