// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it} from 'vitest';
import Gauge from './Gauge.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((app) => unmount(app)));
});

describe('Gauge', () => {
  it('shows a text equivalent for the current speed', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(Gauge, {
      target,
      props: {
        speed: 412_000_000,
        phaseLabel: 'Download',
        phase: 'download',
        locale: 'en',
        running: true,
      },
    });

    mounted.push(app);
    flushSync();

    const gauge = target.querySelector<SVGSVGElement>('svg[role="img"]');

    expect(gauge?.getAttribute('aria-label')).toBe('Download: 412 Mbit/s');
    expect(gauge?.dataset.speedBps).toBe('412000000');
    expect(target.querySelector('[data-testid="gauge-needle"]')).toBeNull();
  });

  it('sizes the SVG and copy inside a bottom-centred arc box', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(Gauge, {
      target,
      props: {
        speed: 412_000_000,
        phaseLabel: 'Download',
        phase: 'download',
        locale: 'en',
        running: true,
      },
    });

    mounted.push(app);
    flushSync();

    const wrap = target.querySelector<HTMLElement>('.gauge-wrap');
    const arcBox = target.querySelector<HTMLElement>('.arc-box');
    const svg = target.querySelector<SVGSVGElement>('.gauge');
    const copy = target.querySelector<HTMLElement>('.gauge-copy');
    const speed = target.querySelector<HTMLElement>('.speed');

    expect(wrap?.style.position).toBe('absolute');
    expect(wrap?.getAttribute('style')).toContain('inset: 0');
    expect(wrap?.style.containerType).toBe('size');
    expect(arcBox?.style.position).toBe('absolute');
    expect(arcBox?.style.insetBlockEnd).toBe('0');
    expect(arcBox?.style.insetInlineStart).toBe('50%');
    expect(arcBox?.getAttribute('style')).toContain('translate: -50% 0');
    expect(arcBox?.getAttribute('style')).toContain('inline-size: min(100cqw, calc(100cqh * 200 / 126))');
    expect(arcBox?.style.aspectRatio).toBe('200 / 126');
    expect(svg?.style.blockSize).toBe('100%');
    expect(svg?.style.inlineSize).toBe('100%');
    expect(copy?.parentElement).toBe(arcBox);
    expect(copy?.style.position).toBe('absolute');
    expect(copy?.getAttribute('style')).toContain('inset-block-end: 18%');
    expect(copy?.style.insetBlockStart).toBe('');
    expect(speed?.getAttribute('style')).toContain('clamp(var(--mndw-text-sm), 9cqmin');
    expect(svg?.getAttribute('preserveAspectRatio')).toBe('xMidYMax meet');
  });

  it('keeps a zero-speed fill path without a round-cap dot', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(Gauge, {
      target,
      props: {
        speed: 0,
        phaseLabel: 'Ready',
        phase: null,
        locale: 'en',
        running: true,
      },
    });

    mounted.push(app);
    flushSync();

    const fill = target.querySelector<SVGPathElement>('[data-testid="gauge-fill"]');

    expect(fill).not.toBeNull();
    expect(fill?.getAttribute('stroke-dasharray')).toBe('0 100');
    expect(fill?.getAttribute('stroke-linecap')).toBe('butt');
  });

  it('renders speed and phase text over the SVG', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(Gauge, {
      target,
      props: {
        speed: 412_000_000,
        phaseLabel: 'Download',
        phase: 'download',
        locale: 'en',
        running: true,
      },
    });

    mounted.push(app);
    flushSync();

    const svg = target.querySelector('svg');
    const tick = target.querySelector<SVGTextElement>('.tick-label');
    const speed = target.querySelector<HTMLElement>('.gauge-copy .speed');
    const phase = target.querySelector<HTMLElement>('.gauge-copy .phase');

    expect(svg?.querySelector('.speed')).toBeNull();
    expect(tick?.style.fontSize).toBe('var(--mndw-text-xs)');
    expect(speed?.getAttribute('style')).toContain('clamp(var(--mndw-text-sm), 9cqmin');
    expect(phase?.style.fontSize).toBe('var(--mndw-text-xs)');
    expect(speed?.textContent).toBe('412 Mbit/s');
    expect(phase?.textContent).toBe('Download');
  });

  it('fills the default range to its arc end at 1000 Mbit/s with no needle', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(Gauge, {
      target,
      props: {
        speed: 1_000_000_000,
        phaseLabel: 'Download',
        phase: 'download',
        locale: 'en',
        running: true,
      },
    });

    mounted.push(app);
    flushSync();

    const track = target.querySelector<SVGPathElement>('.track');
    const fill = target.querySelector<SVGPathElement>('[data-testid="gauge-fill"]');

    expect(track?.getAttribute('d')).toBe('M 16 105 A 84 84 0 0 1 184 105');
    expect(fill?.getAttribute('d')).toBe('M 16 105 A 84 84 0 0 1 184 105');
    expect(fill?.getAttribute('stroke-dasharray')).toBe('100 100');
    expect(fill?.getAttribute('data-color')).toBe('accent');
    expect(target.querySelector('[data-testid="gauge-needle"]')).toBeNull();
  });

  it.each([
    {speed: 1_000_000_000, lastLabelText: '1G'},
    {speed: 10_000_000_000, lastLabelText: '10G'},
  ])('uses a thick track and spaces 0 and $lastLabelText labels away from inward ticks', ({speed, lastLabelText}) => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(Gauge, {
      target,
      props: {
        speed,
        phaseLabel: 'Download',
        phase: 'download',
        locale: 'en',
        running: true,
      },
    });

    mounted.push(app);
    flushSync();

    const track = target.querySelector<SVGPathElement>('.track');
    const fill = target.querySelector<SVGPathElement>('.fill');
    const ticks = Array.from(target.querySelectorAll<SVGLineElement>('.tick'));
    const labels = Array.from(target.querySelectorAll<SVGTextElement>('.tick-label'));
    const firstTick = ticks[0];
    const lastTick = ticks.at(-1);
    const firstLabel = labels[0];
    const lastLabel = labels.at(-1);
    const radius = (xCoordinate: string | null, yCoordinate: string | null): number =>
      Math.hypot(Number(xCoordinate) - 100, Number(yCoordinate) - 105);

    expect(track?.getAttribute('stroke-width')).toBe('6');
    expect(fill?.getAttribute('stroke-width')).toBe('6');
    expect(fill?.getAttribute('stroke-linecap')).toBe('round');
    expect(firstTick).not.toBeNull();
    expect(lastTick).not.toBeNull();
    expect(firstLabel?.textContent?.trim()).toBe('0');
    expect(lastLabel?.textContent?.trim()).toBe(lastLabelText);
    expect(radius(firstTick?.getAttribute('x1') ?? null, firstTick?.getAttribute('y1') ?? null)).toBeCloseTo(81);
    expect(radius(firstTick?.getAttribute('x2') ?? null, firstTick?.getAttribute('y2') ?? null)).toBeCloseTo(78);
    expect(radius(lastTick?.getAttribute('x2') ?? null, lastTick?.getAttribute('y2') ?? null)).toBeCloseTo(78);
    expect(radius(firstLabel?.getAttribute('x') ?? null, firstLabel?.getAttribute('y') ?? null)).toBeCloseTo(62);
    expect(radius(lastLabel?.getAttribute('x') ?? null, lastLabel?.getAttribute('y') ?? null)).toBeCloseTo(62);

    const longestEndLabelHalfWidth = (lastLabel?.textContent?.trim().length ?? 0) * 11 * 0.55 / 2;

    expect(78 - 62 - longestEndLabelHalfWidth).toBeGreaterThanOrEqual(6);
  });

  it('does not render an action button in the gauge while idle', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(Gauge, {
      target,
      props: {
        speed: 0,
        phaseLabel: 'Ready',
        phase: null,
        locale: 'en',
        running: false,
      },
    });

    mounted.push(app);
    flushSync();
    expect(target.querySelector('[data-testid="start"]')).toBeNull();
    expect(target.querySelector('mndw-button')).toBeNull();
    expect(target.querySelector('.gauge-copy .speed')).toBeNull();
  });
});
