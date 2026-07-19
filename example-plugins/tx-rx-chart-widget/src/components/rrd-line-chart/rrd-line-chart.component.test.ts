import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {type ComponentFixture, TestBed} from '@angular/core/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import template from './rrd-line-chart.component.html?raw';
import styles from './rrd-line-chart.component.scss?raw';
import {RrdLineChartComponent} from './rrd-line-chart.component';

let fixture: ComponentFixture<RrdLineChartComponent> | null = null;

async function createFixture(): Promise<ComponentFixture<RrdLineChartComponent>> {
  await resolveComponentResources((url: string) => {
    if (url.endsWith('rrd-line-chart.component.html')) {
      return Promise.resolve(template);
    }

    if (url.endsWith('rrd-line-chart.component.scss')) {
      return Promise.resolve(styles);
    }

    throw new Error(`resource URL: ${url}`);
  });

  await TestBed.configureTestingModule({imports: [RrdLineChartComponent]}).compileComponents();

  fixture = TestBed.createComponent(RrdLineChartComponent);

  const instance = fixture.componentInstance as unknown as {
    txData: () => {t: number; v: number}[];
    rxData: () => {t: number; v: number}[];
    deviceTime: () => Date;
    containerRef: () => {nativeElement: HTMLElement} | undefined;
    drawChart: () => void;
  };

  instance.txData = () => [{t: 1, v: 100}, {t: 2, v: 200}];
  instance.rxData = () => [{t: 1, v: 50}, {t: 2, v: 75}];
  instance.deviceTime = () => new Date(2026, 6, 18, 12, 0, 0);

  fixture.detectChanges();
  await fixture.whenStable();

  const container = (fixture.nativeElement as Element).querySelector<HTMLElement>('.chart-container');

  if (container === null) {
    throw new Error('Missing chart container');
  }

  instance.containerRef = () => ({nativeElement: container});
  instance.drawChart();

  return fixture;
}

afterEach(() => {
  fixture?.destroy();
  fixture = null;
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});

describe('RrdLineChartComponent', () => {
  it('redraws chart when its container size changes', async () => {
    let onResize = (): void => undefined;

    class FakeResizeObserver {
      public constructor(callback: () => void) {
        onResize = callback;
      }

      public observe(_element: Element): void {}

      public unobserve(_element: Element): void {}

      public disconnect(): void {}
    }

    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const componentFixture = await createFixture();
    const container = (componentFixture.nativeElement as Element).querySelector<HTMLElement>('.chart-container');

    expect(container).not.toBeNull();
    expect(container?.querySelector('svg')?.getAttribute('height')).toBe('200');

    if (container === null) {
      throw new Error('Missing chart container');
    }

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      width: 320,
      height: 240,
    } as DOMRect);

    onResize();

    expect(container.querySelector('svg')?.getAttribute('height')).toBe('240');
  });
});
