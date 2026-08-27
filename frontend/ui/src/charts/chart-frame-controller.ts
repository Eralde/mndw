import type {ReactiveController, ReactiveControllerHost} from 'lit';

interface ChartSize {
  width: number;
  height: number;
}

export class ChartFrameController implements ReactiveController {
  /** The currently rendered <svg part="plot">, or null when showing the empty state. */
  public plotElement: SVGSVGElement | null = null;

  /** Renderer-owned teardown for the interaction handlers on the current plot. */
  private disposePlot: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observedContainer: HTMLElement | null = null;

  // Only setAttribute (HTMLElement) + requestUpdate/addController (ReactiveControllerHost)
  // are needed, not the full LitElement surface.
  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly onResize: (size?: ChartSize) => void,
  ) {
    host.addController(this);
  }

  public hostConnected(): void {
    this.host.setAttribute('role', 'img');
    // Reconnect safety: hostDisconnected tears the observer down and Lit does not
    // auto-redraw on reconnect. Request an update so updated() redraws (plotElement
    // is null) and re-observes the container. Harmless on first connect.
    this.host.requestUpdate();
  }

  public hostDisconnected(): void {
    this.disconnectPlot();

    if (this.resizeObserver !== null) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.observedContainer = null;
  }

  public setPlot(svg: SVGSVGElement, disposePlot: () => void): void {
    // Dispose any prior plot first so teardown ownership is structural, not
    // dependent on the caller having run disconnectPlot() beforehand.
    this.disconnectPlot();
    this.plotElement = svg;
    this.disposePlot = disposePlot;
  }

  public observeContainer(container: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    if (this.resizeObserver === null) {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];

        this.onResize(
          entry === undefined ? undefined : {width: entry.contentRect.width, height: entry.contentRect.height},
        );
      });
    }

    if (this.observedContainer === container) {
      return;
    }

    if (this.observedContainer !== null) {
      this.resizeObserver.unobserve(this.observedContainer);
    }

    this.resizeObserver.observe(container);
    this.observedContainer = container;
  }

  public disconnectPlot(): void {
    if (this.disposePlot !== null) {
      this.disposePlot();
      this.disposePlot = null;
    }

    this.plotElement = null;
  }
}
