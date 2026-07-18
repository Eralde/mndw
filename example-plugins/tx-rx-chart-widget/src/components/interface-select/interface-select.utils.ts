export type DropdownPlacement = 'above' | 'below';

export interface DropdownPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: DropdownPlacement;
}

export function getDropdownPosition(
  trigger: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  viewport: {width: number; height: number},
  optionCount: number,
): DropdownPosition {
  const gap = 4;
  const padding = 8;
  const optionHeight = 36;
  const requestedHeight = Math.min(Math.max(optionCount, 1) * optionHeight, 240);
  const belowSpace = Math.max(viewport.height - trigger.bottom - gap - padding, 0);
  const aboveSpace = Math.max(trigger.top - gap - padding, 0);
  const placement = belowSpace < requestedHeight && aboveSpace > belowSpace ? 'above' : 'below';
  const availableSpace = placement === 'above' ? aboveSpace : belowSpace;
  const maxHeight = Math.max(Math.min(requestedHeight, availableSpace), optionHeight);
  const width = Math.min(Math.max(trigger.width, 180), viewport.width - padding * 2);
  const left = Math.min(Math.max(trigger.left, padding), viewport.width - width - padding);
  const top = placement === 'above'
    ? trigger.top - gap - maxHeight
    : trigger.bottom + gap;

  return {left, top, width, maxHeight, placement};
}
