import {
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import type {NetworkInterface} from '../../types/rci.types';
import {type DropdownPosition, getDropdownPosition} from './interface-select.utils';

let selectInstanceId = 0;

@Component({
  selector: 'tx-rx-interface-select',
  standalone: true,
  templateUrl: './interface-select.component.html',
  styleUrls: ['./interface-select.component.scss'],
})
export class InterfaceSelectComponent {
  @Input({required: true})
  public interfaces: NetworkInterface[] = [];

  @Input({required: true})
  public selectedId = '';

  @Output()
  public readonly selectedChange = new EventEmitter<string>();

  protected readonly open = signal(false);
  protected readonly activeIndex = signal(-1);
  protected readonly position = signal<DropdownPosition | null>(null);
  protected readonly listboxId = `tx-rx-interface-listbox-${++selectInstanceId}`;

  private readonly hostElement = inject(ElementRef<HTMLElement>);

  @ViewChild('trigger', {static: true})
  private trigger?: ElementRef<HTMLButtonElement>;

  protected toggleOpen(): void {
    if (this.open()) {
      this.close();

      return;
    }

    this.openDropdown();
  }

  protected onSelect(value: string): void {
    this.selectedChange.emit(value);
    this.close();
  }

  protected selectedLabel(): string {
    const selected = this.interfaces.find((iface) => iface.id === this.selectedId);

    return selected ? (selected.description || selected.id) : '';
  }

  protected activeOptionId(): string | null {
    const index = this.activeIndex();

    return this.open() && index >= 0 ? this.optionId(index) : null;
  }

  protected optionId(index: number): string {
    return `${this.listboxId}-option-${index}`;
  }

  protected onTriggerKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.openIfNeeded();
        this.moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.openIfNeeded();
        this.moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        this.openIfNeeded();
        this.activeIndex.set(this.interfaces.length > 0 ? 0 : -1);
        break;
      case 'End':
        event.preventDefault();
        this.openIfNeeded();
        this.activeIndex.set(this.interfaces.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();

        if (!this.open()) {
          this.openDropdown();
        } else {
          this.selectActive();
        }

        break;
      case 'Escape':
        if (this.open()) {
          event.preventDefault();
          this.close();
        }

        break;
      default:
        break;
    }
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    const target = event.target;

    if (this.open() && target instanceof Node && !this.hostElement.nativeElement.contains(target)) {
      this.close();
    }
  }

  @HostListener('window:resize')
  @HostListener('window:scroll')
  protected onWindowChange(): void {
    if (this.open()) {
      this.updatePosition();
    }
  }

  private openIfNeeded(): void {
    if (!this.open()) {
      this.openDropdown();
    }
  }

  private openDropdown(): void {
    this.activeIndex.set(this.selectedIndex());
    this.updatePosition();
    this.open.set(true);
  }

  private close(): void {
    this.open.set(false);
    this.position.set(null);
  }

  private selectedIndex(): number {
    return this.interfaces.findIndex((iface) => iface.id === this.selectedId);
  }

  private moveActive(direction: number): void {
    const count = this.interfaces.length;

    if (count === 0) {
      this.activeIndex.set(-1);

      return;
    }

    const current = this.activeIndex();
    const start = current < 0 ? (direction > 0 ? -1 : count) : current;

    this.activeIndex.set((start + direction + count) % count);
  }

  private selectActive(): void {
    const index = this.activeIndex();
    const selected = index >= 0 ? this.interfaces[index] : undefined;

    if (selected) {
      this.onSelect(selected.id);
    }
  }

  private updatePosition(): void {
    const trigger = this.trigger;

    if (!trigger) {
      return;
    }

    this.position.set(getDropdownPosition(
      trigger.nativeElement.getBoundingClientRect(),
      {width: window.innerWidth, height: window.innerHeight},
      this.interfaces.length,
    ));
  }
}
