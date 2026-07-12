import {clampChroma, formatHex, oklch} from 'culori';
import {contrastRatio} from './contrast.js';

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export function oklchToHex(l: number, c: number, h: number): string {
  const clamped = clampChroma({mode: 'oklch', l, c, h}, 'oklch');

  return formatHex(clamped ?? {mode: 'oklch', l, c: 0, h});
}

// Decompose a hex color into OKLCH. Achromatic colors report hue 0.
export function oklchOf(hex: string): Oklch {
  const parsed = oklch(hex);

  if (!parsed) {
    return {l: 0, c: 0, h: 0};
  }

  return {l: parsed.l, c: parsed.c, h: parsed.h ?? 0};
}

// Shift a hex color's lightness by delta (clamped 0..1), preserving chroma/hue.
export function shiftLightness(hex: string, delta: number): string {
  const {l, c, h} = oklchOf(hex);

  return oklchToHex(Math.min(1, Math.max(0, l + delta)), c, h);
}

// Interpolate a neutral ramp between two hex endpoints in OKLCH. Endpoints are
// pinned exactly (index 0 = fromHex, last = toHex); interior steps blend L/C/H.
export function rampBetween(fromHex: string, toHex: string, steps: number): string[] {
  const from = oklchOf(fromHex);
  const to = oklchOf(toHex);
  const ramp: string[] = [];

  for (let i = 0; i < steps; i++) {
    if (i === 0) {
      ramp.push(fromHex);
      continue;
    }

    if (i === steps - 1) {
      ramp.push(toHex);
      continue;
    }

    const t = i / (steps - 1);
    const l = from.l + (to.l - from.l) * t;
    const c = from.c + (to.c - from.c) * t;
    const h = from.h + (to.h - from.h) * t;

    ramp.push(oklchToHex(l, c, h));
  }

  return ramp;
}

export function buildRamp(
  opts: {hue: number; chroma: number; steps: number; lMin: number; lMax: number},
): string[] {
  const {hue, chroma, steps, lMin, lMax} = opts;
  const ramp: string[] = [];

  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const l = lMin + (lMax - lMin) * t;

    ramp.push(oklchToHex(l, chroma, hue));
  }

  return ramp;
}

export function nudgeForContrast(
  opts: {hue: number; chroma: number; l: number; bgHex: string; target: number},
): string {
  const {hue, chroma, bgHex, target} = opts;
  const step = 0.01;
  let l = opts.l;

  // Head toward whichever extreme (white or black) yields more contrast on the
  // background. A local 1-step probe is unreliable when l sits near the bg luminance.
  const towardLight = contrastRatio(oklchToHex(1, 0, hue), bgHex);
  const towardDark = contrastRatio(oklchToHex(0, 0, hue), bgHex);
  const direction = towardLight >= towardDark ? step : -step;

  let hex = oklchToHex(l, chroma, hue);

  while (contrastRatio(hex, bgHex) < target && l > 0 && l < 1) {
    l = Math.min(1, Math.max(0, l + direction));
    hex = oklchToHex(l, chroma, hue);
  }

  return hex;
}

// Nudge an existing hex color's lightness (preserving its chroma/hue) until it
// clears the target contrast against bgHex. Direction chosen by the extremes.
export function nudgeHexForContrast(fgHex: string, bgHex: string, target: number): string {
  const {c, h} = oklchOf(fgHex);
  const step = 0.01;
  let l = oklchOf(fgHex).l;

  const towardLight = contrastRatio(oklchToHex(1, 0, h), bgHex);
  const towardDark = contrastRatio(oklchToHex(0, 0, h), bgHex);
  const direction = towardLight >= towardDark ? step : -step;

  let hex = oklchToHex(l, c, h);

  while (contrastRatio(hex, bgHex) < target && l > 0 && l < 1) {
    l = Math.min(1, Math.max(0, l + direction));
    hex = oklchToHex(l, c, h);
  }

  return hex;
}
