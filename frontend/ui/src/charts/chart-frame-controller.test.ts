// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ReactiveControllerHost} from 'lit';
import {ChartFrameController} from './chart-frame-controller.js';

type ObserverCallback = (entries: ResizeObserverEntry[]) => void;

class FakeHost {
  public addController = vi.fn();
  public removeController = vi.fn();
  public requestUpdate = vi.fn();
  public setAttribute = vi.fn();
  public readonly updateComplete = Promise.resolve(true);
}

const makeController = (
  onResize: (size?: {width: number; height: number}) => void = vi.fn(),
): {controller: ChartFrameController; host: FakeHost} => {
  const host = new FakeHost();
  const controller = new ChartFrameController(host as unknown as ReactiveControllerHost & HTMLElement, onResize);

  return {controller, host};
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// eslint-disable-next-line max-lines-per-function -- controller lifecycle cases stay together.
describe('ChartFrameController', () => {
  it('registers itself with the host on construction', () => {
    const {host} = makeController();

    expect(host.addController).toHaveBeenCalledOnce();
  });

  it('sets role="img" and requests an update on connect', () => {
    const {controller, host} = makeController();

    controller.hostConnected();

    expect(host.setAttribute).toHaveBeenCalledWith('role', 'img');
    expect(host.requestUpdate).toHaveBeenCalledOnce();
  });

  it('observes a container and forwards resize sizes to onResize', () => {
    let callback: ObserverCallback | undefined;
    const observe = vi.fn();

    class TestResizeObserver {
      constructor(next: ObserverCallback) {
        callback = next;
      }
      public observe = observe;
      public unobserve = vi.fn();
      public disconnect = vi.fn();
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const onResize = vi.fn();
    const {controller} = makeController(onResize);
    const container = document.createElement('div');

    controller.observeContainer(container);
    expect(observe).toHaveBeenCalledWith(container);

    callback?.([{contentRect: {width: 320, height: 180}} as ResizeObserverEntry]);
    expect(onResize).toHaveBeenCalledWith({width: 320, height: 180});
  });

  it('re-observing the same container is a no-op; a new container unobserves the old', () => {
    const observe = vi.fn();
    const unobserve = vi.fn();

    class TestResizeObserver {
      constructor(_next: ObserverCallback) {}
      public observe = observe;
      public unobserve = unobserve;
      public disconnect = vi.fn();
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const {controller} = makeController();
    const first = document.createElement('div');
    const second = document.createElement('div');

    controller.observeContainer(first);
    controller.observeContainer(first);
    expect(observe).toHaveBeenCalledTimes(1);

    controller.observeContainer(second);
    expect(unobserve).toHaveBeenCalledWith(first);
    expect(observe).toHaveBeenLastCalledWith(second);
  });

  it('does nothing when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);

    const {controller} = makeController();

    expect(() => controller.observeContainer(document.createElement('div'))).not.toThrow();
  });

  it('runs the renderer disposer exactly once on disconnectPlot and clears the plot', () => {
    const {controller} = makeController();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const dispose = vi.fn();

    controller.setPlot(svg, dispose);
    expect(controller.plotElement).toBe(svg);

    controller.disconnectPlot();
    expect(dispose).toHaveBeenCalledOnce();
    expect(controller.plotElement).toBeNull();

    controller.disconnectPlot();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('self-disposes a prior plot when setPlot is called again without disconnectPlot', () => {
    const {controller} = makeController();
    const svgA = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const svgB = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const disposeA = vi.fn();
    const disposeB = vi.fn();

    controller.setPlot(svgA, disposeA);
    controller.setPlot(svgB, disposeB);

    expect(disposeA).toHaveBeenCalledOnce();
    expect(disposeB).not.toHaveBeenCalled();
    expect(controller.plotElement).toBe(svgB);
  });

  it('disposes the plot and tears down the observer on disconnect', () => {
    const disconnect = vi.fn();

    class TestResizeObserver {
      constructor(_next: ObserverCallback) {}
      public observe = vi.fn();
      public unobserve = vi.fn();
      public disconnect = disconnect;
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const {controller} = makeController();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const dispose = vi.fn();

    controller.observeContainer(document.createElement('div'));
    controller.setPlot(svg, dispose);

    controller.hostDisconnected();

    expect(dispose).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(controller.plotElement).toBeNull();
  });

  it('re-observes the container after a reconnect', () => {
    let callback: ObserverCallback | undefined;
    const observe = vi.fn();

    class TestResizeObserver {
      constructor(next: ObserverCallback) {
        callback = next;
      }
      public observe = observe;
      public unobserve = vi.fn();
      public disconnect = vi.fn();
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const onResize = vi.fn();
    const {controller, host} = makeController(onResize);
    const container = document.createElement('div');

    controller.observeContainer(container);
    controller.hostDisconnected();

    controller.hostConnected();
    expect(host.requestUpdate).toHaveBeenCalled();

    // Simulate the redraw the requested update drives.
    controller.observeContainer(container);
    callback?.([{contentRect: {width: 200, height: 100}} as ResizeObserverEntry]);
    expect(onResize).toHaveBeenCalledWith({width: 200, height: 100});
  });
});
