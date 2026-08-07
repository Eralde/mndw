import {beforeEach, describe, expect, it} from 'vitest';
import type {OverlayPlacement} from '@mndw/sdk';
import {
  POPOVER_FLIP_ORDER,
  coercePlacement,
  computePopoverCoords,
  isMobileSheet,
  resolveSizing,
} from './overlay-position.js';

interface RectValues {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Size {
  width: number;
  height: number;
}

const DESKTOP = {width: 1280, height: 800};
const MOBILE = {width: 390, height: 844};
const CONTENT: Size = {width: 200, height: 120};

function anchorWithRect(rect: RectValues): HTMLElement {
  const anchor = document.createElement('button');

  Object.defineProperty(anchor, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  });

  return anchor;
}

function coords(
  rect: RectValues,
  placement: OverlayPlacement,
  viewport = DESKTOP,
): {top: number; left: number; placement: OverlayPlacement} {
  return computePopoverCoords(
    {element: anchorWithRect(rect)},
    CONTENT,
    placement,
    viewport,
  );
}

describe('host overlay positioning characterization', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the public flip order stable', () => {
    expect(POPOVER_FLIP_ORDER).toEqual(['bottom-start', 'top-start', 'bottom-end', 'top-end']);
  });

  it.each(
    [
      ['modal', undefined, 'center'],
      ['drawer', undefined, 'right'],
      ['drawer', 'left', 'left'],
      ['popover', undefined, 'bottom-start'],
      ['popover', 'top-end', 'top-end'],
      ['custom', undefined, 'center'],
    ] as const,
  )('coerces %s placement %s to %s', (kind, requested, expected) => {
    expect(coercePlacement(kind, requested)).toBe(expected);
  });

  it.each(
    [
      [
        'top-left edge flips below',
        {top: 8, right: 40, bottom: 40, left: 8},
        'top-start',
        {top: 48, left: 8, placement: 'bottom-start'},
      ],
      [
        'top-right edge flips below',
        {top: 8, right: 1272, bottom: 40, left: 1240},
        'top-end',
        {top: 48, left: 1072, placement: 'bottom-end'},
      ],
      [
        'bottom-left edge flips above',
        {top: 760, right: 40, bottom: 792, left: 8},
        'bottom-start',
        {top: 632, left: 8, placement: 'top-start'},
      ],
      [
        'bottom-right edge flips above',
        {top: 760, right: 1272, bottom: 792, left: 1240},
        'bottom-end',
        {top: 632, left: 1072, placement: 'top-end'},
      ],
      [
        'left placement preserves current fallback coordinates',
        {top: 300, right: 40, bottom: 332, left: 8},
        'left-start',
        {top: 340, left: 8, placement: 'left-start'},
      ],
      [
        'right placement preserves current fallback coordinates',
        {top: 300, right: 1272, bottom: 332, left: 1240},
        'right-end',
        {top: 340, left: 1072, placement: 'bottom-end'},
      ],
    ] as const,
  )('characterizes %s', (_name, rect, placement, expected) => {
    expect(coords(rect, placement)).toEqual(expected);
  });

  it.each(
    [
      ['desktop viewport', DESKTOP, false],
      ['mobile viewport', MOBILE, false],
    ] as const,
  )('does not classify popovers as mobile sheets: %s', (_name, viewport, expected) => {
    expect(isMobileSheet('popover', viewport.width)).toBe(expected);
  });

  it.each(
    [
      ['modal', true],
      ['drawer', true],
      ['custom', false],
    ] as const,
  )('uses mobile sheet presentation for %s at the mobile width', (kind, expected) => {
    expect(isMobileSheet(kind, MOBILE.width)).toBe(expected);
  });

  it('keeps desktop modal and drawer sizing defaults', () => {
    expect(resolveSizing('modal', {kind: 'modal'})).toEqual({
      width: 'min(560px, calc(100vw - 32px))',
      height: undefined,
      maxWidth: undefined,
      maxHeight: 'calc(100vh - 32px)',
    });
    expect(resolveSizing('drawer', {kind: 'drawer'})).toEqual({
      width: 'min(420px, 100vw)',
      height: '100%',
      maxWidth: undefined,
      maxHeight: undefined,
    });
  });

  it('uses content-sized mobile sheets at both viewport sizes', () => {
    expect(resolveSizing('modal', {kind: 'modal'}, true)).toEqual({
      width: '100%',
      height: 'auto',
      maxHeight: '100dvh',
    });
    expect(resolveSizing('drawer', {kind: 'drawer'}, true)).toEqual({
      width: '100%',
      height: 'auto',
      maxHeight: '100dvh',
    });
    expect(resolveSizing('modal', {kind: 'modal'}, false)).not.toEqual(
      resolveSizing('modal', {kind: 'modal'}, true),
    );
  });

  it('preserves explicit numeric and CSS sizing', () => {
    expect(resolveSizing('popover', {
      kind: 'popover',
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
});
