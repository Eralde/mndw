// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import type {OverlayPlacement} from '@mndw/sdk';
import {
  type AnchorRect,
  POPOVER_FLIP_ORDER,
  availablePopoverHeight,
  coercePlacement,
  computePopoverCoords,
  computeTooltipCoords,
  resolveSizing,
  selectPresentation,
} from './position.js';

interface RectValues {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DESKTOP = {width: 1280, height: 800};
const CONTENT = {width: 200, height: 120};

function compute(
  rect: RectValues,
  placement: OverlayPlacement,
): {top: number; left: number; placement: OverlayPlacement} {
  const anchor = document.createElement('button');

  Object.defineProperty(anchor, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  });

  return computePopoverCoords({element: anchor}, CONTENT, placement, DESKTOP);
}

describe('shared positioning', () => {
  it('preserves host flip order and edge placement outputs', () => {
    expect(POPOVER_FLIP_ORDER).toEqual(['bottom-start', 'top-start', 'bottom-end', 'top-end']);

    expect(compute({top: 8, right: 40, bottom: 40, left: 8}, 'top-start')).toEqual({
      top: 48,
      left: 8,
      placement: 'bottom-start',
    });
    expect(compute({top: 760, right: 1272, bottom: 792, left: 1240}, 'bottom-end')).toEqual({
      top: 632,
      left: 1072,
      placement: 'top-end',
    });
    expect(compute({top: 300, right: 1272, bottom: 332, left: 1240}, 'right-end')).toEqual({
      top: 340,
      left: 1072,
      placement: 'bottom-end',
    });
  });

  it('parameterizes select presentation breakpoint', () => {
    expect(selectPresentation(600)).toBe('sheet');
    expect(selectPresentation(601)).toBe('popover');
    expect(selectPresentation(720, 720)).toBe('sheet');
    expect(selectPresentation(721, 720)).toBe('popover');
  });

  it('parameterizes popover gap and viewport padding', () => {
    expect(availablePopoverHeight(
      {top: 300, bottom: 332},
      {width: 1200, height: 868},
      4,
      10,
    )).toBe(522);
  });

  it('preserves overlay sizing resolution', () => {
    expect(resolveSizing('modal', {kind: 'modal'})).toEqual({
      width: 'min(560px, calc(100vw - 32px))',
      height: undefined,
      maxWidth: undefined,
      maxHeight: 'calc(100vh - 32px)',
    });
    expect(resolveSizing('modal', {
      kind: 'modal',
      width: 320,
      height: '40vh',
      maxWidth: 640,
      maxHeight: '80vh',
    })).toEqual({
      width: '320px',
      height: '40vh',
      maxWidth: '640px',
      maxHeight: '80vh',
    });
  });

  it('preserves placement coercion', () => {
    expect(coercePlacement('modal')).toBe('center');
    expect(coercePlacement('drawer')).toBe('right');
    expect(coercePlacement('popover')).toBe('bottom-start');
    expect(coercePlacement('custom')).toBe('center');
  });
});

const TOOLTIP = {width: 100, height: 40};

function tooltipRect(top: number, left: number, width = 60, height = 20): AnchorRect {
  return {top, left, right: left + width, bottom: top + height, width, height};
}

describe('tooltip positioning', () => {
  it('centres the tooltip on the requested side', () => {
    expect(computeTooltipCoords(tooltipRect(400, 600), TOOLTIP, 'top', DESKTOP))
      .toEqual({top: 352, left: 580, placement: 'top'});
    expect(computeTooltipCoords(tooltipRect(400, 600), TOOLTIP, 'bottom', DESKTOP))
      .toEqual({top: 428, left: 580, placement: 'bottom'});
    expect(computeTooltipCoords(tooltipRect(400, 600), TOOLTIP, 'left', DESKTOP))
      .toEqual({top: 390, left: 492, placement: 'left'});
    expect(computeTooltipCoords(tooltipRect(400, 600), TOOLTIP, 'right', DESKTOP))
      .toEqual({top: 390, left: 668, placement: 'right'});
  });

  it('flips to the opposite side when the preferred one is clipped', () => {
    expect(computeTooltipCoords(tooltipRect(10, 600), TOOLTIP, 'top', DESKTOP).placement).toBe('bottom');
    expect(computeTooltipCoords(tooltipRect(780, 600), TOOLTIP, 'bottom', DESKTOP).placement).toBe('top');
    expect(computeTooltipCoords(tooltipRect(400, 20), TOOLTIP, 'left', DESKTOP).placement).toBe('right');
    expect(computeTooltipCoords(tooltipRect(400, 1220), TOOLTIP, 'right', DESKTOP).placement).toBe('left');
  });

  it('leaves the requested axis when a corner clips both sides of it', () => {
    // A viewport too short for the tooltip above or below the anchor, but wide enough beside it.
    expect(computeTooltipCoords(tooltipRect(20, 600), TOOLTIP, 'top', {width: 1280, height: 60}).placement)
      .toBe('right');
  });

  it('clamps the cross axis into the viewport', () => {
    expect(computeTooltipCoords(tooltipRect(400, 0), TOOLTIP, 'top', DESKTOP).left).toBe(8);
    expect(computeTooltipCoords(tooltipRect(400, 1220), TOOLTIP, 'top', DESKTOP).left).toBe(1172);
    expect(computeTooltipCoords(tooltipRect(0, 600), TOOLTIP, 'right', DESKTOP).top).toBe(8);
  });

  it('falls back to the preferred side when nothing fits', () => {
    const coords = computeTooltipCoords(tooltipRect(20, 20), TOOLTIP, 'top', {width: 60, height: 60});

    expect(coords.placement).toBe('top');
    expect(coords.left).toBe(8);
  });

  it('parameterizes the anchor gap and viewport padding', () => {
    expect(computeTooltipCoords(tooltipRect(400, 600), TOOLTIP, 'bottom', DESKTOP, 0).top).toBe(420);
    expect(computeTooltipCoords(tooltipRect(400, 0), TOOLTIP, 'top', DESKTOP, 8, 20).left).toBe(20);
  });
});
