import {describe, expect, it, vi} from 'vitest';
import {AriaKeyManager, type KeyManagerList} from './key-manager.js';

interface Item {
  label: string;
  disabled?: boolean;
}

const items: Item[] = [
  {label: 'Alpine'},
  {label: 'Beta', disabled: true},
  {label: 'Birch'},
  {label: 'Cedar'},
  {label: 'Delta'},
  {label: 'Elm'},
  {label: 'Fir'},
  {label: 'Grove'},
  {label: 'Hazel'},
  {label: 'Iris'},
  {label: 'Juniper'},
  {label: 'Kelp'},
  {label: 'Larch'},
];

function keyEvent(key: string): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

function setup(
  activeIndex = 0,
  wrap = false,
  mode: 'active-descendant' | 'roving-focus' = 'active-descendant',
  listItems: readonly Item[] = items,
): {
  manager: AriaKeyManager<Item>;
  list: KeyManagerList<Item>;
  focusItem: ReturnType<typeof vi.fn>;
  press: (key: string) => boolean;
} {
  const focusItem = vi.fn();
  const list: KeyManagerList<Item> = {
    items: listItems,
    activeIndex,
    wrap,
    mode,
    setActiveIndex(index: number): void {
      list.activeIndex = index;
    },
    focusItem,
  };
  const manager = new AriaKeyManager<Item>({
    getLabel: (item) => item.label,
    isDisabled: (item) => item.disabled === true,
  });
  const press = (key: string): boolean => {
    return manager.handleKeydown(keyEvent(key), list);
  };

  return {manager, list, focusItem, press};
}

describe('AriaKeyManager', () => {
  it.each([
    {key: 'ArrowDown', start: 0, expected: 2},
    {key: 'ArrowUp', start: 3, expected: 2},
    {key: 'Home', start: 8, expected: 0},
    {key: 'End', start: 0, expected: 12},
    {key: 'PageDown', start: 0, expected: 10},
    {key: 'PageUp', start: 12, expected: 2},
  ])('moves with $key and skips disabled options', ({key, start, expected}) => {
    const {list, press} = setup(start);

    expect(press(key)).toBe(true);
    expect(list.activeIndex).toBe(expected);
  });

  it('does not wrap arrow navigation when wrapping is disabled', () => {
    const {list, press} = setup(12);

    expect(press('ArrowDown')).toBe(true);
    expect(list.activeIndex).toBe(12);
  });

  it('wraps arrows and skips disabled options when enabled', () => {
    const {list, press} = setup(12, true);

    press('ArrowDown');
    expect(list.activeIndex).toBe(0);
    press('ArrowUp');
    expect(list.activeIndex).toBe(12);
  });

  it('moves by one page and finds an enabled option in the travel direction', () => {
    const {list, press} = setup(0);

    press('PageDown');
    expect(list.activeIndex).toBe(10);
    press('PageUp');
    expect(list.activeIndex).toBe(0);
  });

  it('matches a multi-character typeahead buffer', () => {
    const {list, press} = setup(0);

    press('b');
    press('i');

    expect(list.activeIndex).toBe(2);
  });

  it('cycles repeated characters to the next matching item', () => {
    const repeated = [{label: 'Alpine'}, {label: 'Aspen'}, {label: 'Ash'}];
    const {manager, list} = setup(0, false, 'active-descendant', repeated);

    manager.handleKeydown(keyEvent('a'), list);
    expect(list.activeIndex).toBe(1);
    manager.handleKeydown(keyEvent('a'), list);
    expect(list.activeIndex).toBe(2);
  });

  it('resets the typeahead buffer after its timeout', () => {
    let now = 0;
    const manager = new AriaKeyManager<Item>({
      getLabel: (item) => item.label,
      isDisabled: (item) => item.disabled === true,
      now: () => now,
    });
    const list = setup().list;

    manager.handleKeydown(keyEvent('b'), list);
    now = 1000;
    manager.handleKeydown(keyEvent('e'), list);

    expect(list.activeIndex).toBe(5);
  });

  it('supports active-descendant and roving-focus consumers', () => {
    const activeDescendant = setup();
    const roving = setup(0, false, 'roving-focus');

    activeDescendant.press('ArrowDown');
    roving.press('ArrowDown');

    expect(activeDescendant.list.activeIndex).toBe(2);
    expect(activeDescendant.focusItem).not.toHaveBeenCalled();
    expect(roving.list.activeIndex).toBe(2);
    expect(roving.focusItem).toHaveBeenCalledWith(2);
  });

  it('leaves activation, Escape, Tab, and non-printable keys to the owner', () => {
    const {press} = setup();

    expect(press('Enter')).toBe(false);
    expect(press(' ')).toBe(false);
    expect(press('Escape')).toBe(false);
    expect(press('Tab')).toBe(false);
    expect(press('ArrowLeft')).toBe(false);
  });
});
