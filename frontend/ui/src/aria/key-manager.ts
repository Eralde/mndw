export type KeyManagerMode = 'active-descendant' | 'roving-focus';

export interface KeyManagerList<Item> {
  readonly items: readonly Item[];
  readonly wrap: boolean;
  readonly mode: KeyManagerMode;
  activeIndex: number;
  setActiveIndex(index: number): void;
  focusItem?(index: number): void;
}

export interface AriaKeyManagerOptions<Item> {
  readonly getLabel: (item: Item) => string;
  readonly isDisabled: (item: Item) => boolean;
  readonly pageSize?: number;
  readonly typeaheadTimeout?: number;
  readonly now?: () => number;
}

/** Framework-free keyboard navigation for listbox, menu, and other composite widget options. */
export class AriaKeyManager<Item> {
  private readonly getLabel: (item: Item) => string;
  private readonly isDisabled: (item: Item) => boolean;
  private readonly pageSize: number;
  private readonly typeaheadTimeout: number;
  private readonly now: () => number;
  private typeaheadBuffer = '';
  private lastTypeaheadAt = Number.NEGATIVE_INFINITY;

  constructor(options: AriaKeyManagerOptions<Item>) {
    this.getLabel = options.getLabel;
    this.isDisabled = options.isDisabled;
    this.pageSize = options.pageSize ?? 10;
    this.typeaheadTimeout = options.typeaheadTimeout ?? 500;
    this.now = options.now ?? Date.now;
  }

  public handleKeydown(event: KeyboardEvent, list: KeyManagerList<Item>): boolean {
    let nextIndex: number | null = null;

    switch (event.key) {
      case 'ArrowDown':
        nextIndex = this.move(list, 1);
        break;
      case 'ArrowUp':
        nextIndex = this.move(list, -1);
        break;
      case 'Home':
        nextIndex = this.edge(list, 1);
        break;
      case 'End':
        nextIndex = this.edge(list, -1);
        break;
      case 'PageDown':
        nextIndex = this.page(list, 1);
        break;
      case 'PageUp':
        nextIndex = this.page(list, -1);
        break;
      default:
        if (this.isPrintable(event)) {
          nextIndex = this.typeahead(event.key, list);
        } else {
          return false;
        }
    }

    event.preventDefault();

    if (nextIndex !== null && nextIndex !== list.activeIndex) {
      list.setActiveIndex(nextIndex);

      if (list.mode === 'roving-focus') {
        list.focusItem?.(nextIndex);
      }
    }

    return true;
  }

  private isPrintable(event: KeyboardEvent): boolean {
    return !event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && !event.isComposing
      && event.key !== ' '
      && [...event.key].length === 1;
  }

  private move(list: KeyManagerList<Item>, direction: 1 | -1): number | null {
    const count = list.items.length;

    if (count === 0) {
      return null;
    }

    let index = list.activeIndex;

    if (index < 0) {
      return this.edge(list, direction);
    }

    for (let step = 0; step < count; step += 1) {
      index += direction;

      if (list.wrap) {
        index = (index + count) % count;
      } else if (index < 0 || index >= count) {
        return null;
      }

      if (!this.isDisabled(list.items[index])) {
        return index;
      }
    }

    return null;
  }

  private edge(list: KeyManagerList<Item>, direction: 1 | -1): number | null {
    const start = direction > 0 ? 0 : list.items.length - 1;
    const end = direction > 0 ? list.items.length : -1;

    for (let index = start; index !== end; index += direction) {
      if (!this.isDisabled(list.items[index])) {
        return index;
      }
    }

    return null;
  }

  private page(list: KeyManagerList<Item>, direction: 1 | -1): number | null {
    if (list.items.length === 0) {
      return null;
    }

    if (list.activeIndex < 0) {
      return this.edge(list, direction);
    }

    const target = list.activeIndex + direction * this.pageSize;
    let index = list.wrap
      ? (target % list.items.length + list.items.length) % list.items.length
      : Math.max(0, Math.min(list.items.length - 1, target));

    let step = 0;

    while (step < list.items.length) {
      if (!this.isDisabled(list.items[index])) {
        return index;
      }

      index += direction;

      if (list.wrap) {
        index = (index + list.items.length) % list.items.length;
      } else if (index < 0 || index >= list.items.length) {
        return null;
      }

      step += 1;
    }

    return null;
  }

  private typeahead(key: string, list: KeyManagerList<Item>): number | null {
    const now = this.now();
    const withinTimeout = now - this.lastTypeaheadAt <= this.typeaheadTimeout;
    const prior = withinTimeout ? this.typeaheadBuffer : '';
    const repeated = prior !== '' && [...prior].every((character) => character === key.toLocaleLowerCase());
    const next = repeated ? key.toLocaleLowerCase() : `${prior}${key}`.toLocaleLowerCase();

    this.typeaheadBuffer = next;
    this.lastTypeaheadAt = now;

    const current = list.items[list.activeIndex];

    // Keep the current match as a multi-character buffer grows (for example B then I on Birch).
    if (
      prior !== ''
      && !repeated
      && current
      && !this.isDisabled(current)
      && this.normalize(this.getLabel(current)).startsWith(next)
    ) {
      return list.activeIndex;
    }

    const count = list.items.length;

    for (let step = 1; step <= count; step += 1) {
      const index = list.activeIndex < 0
        ? step - 1
        : (list.activeIndex + step) % count;
      const item = list.items[index];

      if (!this.isDisabled(item) && this.normalize(this.getLabel(item)).startsWith(next)) {
        return index;
      }
    }

    return null;
  }

  private normalize(value: string): string {
    return value.trimStart().toLocaleLowerCase();
  }
}
