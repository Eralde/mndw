import {LitElement, type TemplateResult, css, html} from 'lit';

const DEFAULT_MIN_THUMB_PX = 24;

export const MNDW_SCROLL_AREA_TAG = 'mndw-scroll-area';

function nonNegativeFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export class MndwScrollArea extends LitElement {
  public static readonly styles = css`
    :host {
      box-sizing: border-box;
      display: flex;
      flex: 0 1 auto;
      flex-direction: column;
      min-height: 0;
      max-width: 100%;
      position: relative;
      overflow: hidden;
    }

    .viewport {
      min-height: 0;
      flex: 0 1 auto;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-width: none;
    }

    .viewport::-webkit-scrollbar {
      display: none;
    }

    .scrollbar {
      display: none;
      position: absolute;
      inset-block: 0;
      inset-inline-end: 0;
      width: var(--mndw-scrollbar-size);
      touch-action: none;
      user-select: none;
    }

    .track {
      height: 100%;
      border-radius: var(--mndw-scrollbar-radius);
      background: var(--mndw-scrollbar-track);
      touch-action: none;
    }

    .thumb {
      box-sizing: border-box;
      border: var(--mndw-focus-w) solid var(--mndw-scrollbar-track);
      border-radius: var(--mndw-scrollbar-radius);
      background: var(--mndw-scrollbar-thumb);
      touch-action: none;
    }

    .thumb:hover,
    .thumb.dragging {
      background: var(--mndw-scrollbar-thumb-hover);
    }

    :host(.dragging) {
      user-select: none;
    }

    [data-measure='thumb-min'] {
      position: absolute;
      visibility: hidden;
      width: 0;
      height: var(--mndw-scrollbar-thumb-min-size);
      pointer-events: none;
    }
  `;

  private viewportResizeObserver: ResizeObserver | null = null;
  private contentResizeObserver: ResizeObserver | null = null;
  private refreshFrame: number | null = null;
  private shouldMeasureOnRefresh = true;
  private measuredMinThumbPx = DEFAULT_MIN_THUMB_PX;
  private assignedContent: Element | null = null;
  private listenersAttached = false;
  private activeDrag: {pointerId: number; offset: number; captureTarget: HTMLElement} | null = null;
  private maxScroll = 0;
  private thumbLength = 0;
  private trackTravel = 0;
  private trackTop = 0;

  public get viewportElement(): HTMLElement | null {
    return this.shadowRoot?.querySelector<HTMLElement>('[part="viewport"]') ?? null;
  }

  public refresh(): void {
    this.scheduleRefresh(true);
  }

  protected override firstUpdated(): void {
    this.attachListeners();
    this.scheduleRefresh(true);
  }

  public override connectedCallback(): void {
    super.connectedCallback();

    if (this.hasUpdated) {
      this.attachListeners();
      this.scheduleRefresh(true);
    }
  }

  public override disconnectedCallback(): void {
    const viewport = this.viewportElement;

    if (viewport && this.listenersAttached) {
      viewport.removeEventListener('scroll', this.handleScroll);
    }

    this.listenersAttached = false;
    this.viewportResizeObserver?.disconnect();
    this.contentResizeObserver?.disconnect();
    this.assignedContent = null;

    if (this.refreshFrame !== null) {
      cancelAnimationFrame(this.refreshFrame);
      this.refreshFrame = null;
    }

    this.shouldMeasureOnRefresh = true;
    this.endDrag();
    super.disconnectedCallback();
  }

  protected override render(): TemplateResult {
    return html`
      <div part="viewport" class="viewport"><slot @slotchange=${this.handleSlotChange}></slot></div>
      <div
        part="scrollbar"
        class="scrollbar"
        aria-hidden="true"
        @pointermove=${this.handlePointerMove}
        @pointerup=${this.handlePointerUp}
        @pointercancel=${this.handlePointerCancel}
      >
        <div part="track" class="track" @pointerdown=${this.handleTrackPointerDown}>
          <div part="thumb" class="thumb" @pointerdown=${this.handleThumbPointerDown}></div>
        </div>
      </div>
      <div data-measure="thumb-min" aria-hidden="true"></div>
    `;
  }

  private attachListeners(): void {
    const viewport = this.viewportElement;

    if (!viewport) {
      return;
    }

    if (!this.listenersAttached) {
      viewport.addEventListener('scroll', this.handleScroll, {passive: true});
      this.listenersAttached = true;
    }

    if (typeof ResizeObserver !== 'undefined') {
      if (!this.viewportResizeObserver) {
        this.viewportResizeObserver = new ResizeObserver(this.handleResize);
      }

      if (!this.contentResizeObserver) {
        this.contentResizeObserver = new ResizeObserver(this.handleResize);
      }

      this.viewportResizeObserver.observe(viewport);
      this.observeAssignedContent();
    }
  }

  private observeAssignedContent(): void {
    const slot = this.shadowRoot?.querySelector<HTMLSlotElement>('slot');

    if (!slot || !this.contentResizeObserver) {
      return;
    }

    const nextContent = slot.assignedElements({flatten: true})[0] ?? null;

    if (nextContent === this.assignedContent) {
      return;
    }

    this.contentResizeObserver.disconnect();
    this.assignedContent = nextContent;

    if (nextContent) {
      this.contentResizeObserver.observe(nextContent);
    }
  }

  private scheduleRefresh(measure: boolean): void {
    if (measure) {
      this.shouldMeasureOnRefresh = true;
    }

    if (this.refreshFrame !== null) {
      return;
    }

    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = null;

      const shouldMeasure = this.shouldMeasureOnRefresh;

      this.shouldMeasureOnRefresh = false;
      this.updateGeometry(shouldMeasure);
    });
  }

  private updateGeometry(shouldMeasure: boolean): void {
    const viewport = this.viewportElement;
    const scrollbar = this.shadowRoot?.querySelector<HTMLElement>('[part="scrollbar"]');
    const track = this.shadowRoot?.querySelector<HTMLElement>('[part="track"]');
    const thumb = this.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');

    if (!viewport || !scrollbar || !track || !thumb) {
      return;
    }

    if (shouldMeasure) {
      this.measuredMinThumbPx = this.measureMinimumThumb();
    }

    const clientHeight = nonNegativeFinite(viewport.clientHeight);
    const scrollHeight = nonNegativeFinite(viewport.scrollHeight);
    const scrollTop = nonNegativeFinite(viewport.scrollTop);

    scrollbar.style.display = 'block';

    const trackRect = track.getBoundingClientRect();
    const trackHeight = nonNegativeFinite(trackRect.height);
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const hasOverflow = maxScroll > 1;
    const showScrollbar = hasOverflow && trackHeight > 0;

    this.trackTop = Number.isFinite(trackRect.top) ? trackRect.top : 0;
    this.maxScroll = maxScroll;
    scrollbar.style.display = showScrollbar ? 'block' : 'none';

    if (!showScrollbar) {
      this.thumbLength = trackHeight;
      this.trackTravel = 0;
      thumb.style.height = `${trackHeight}px`;
      thumb.style.transform = 'translateY(0px)';

      return;
    }

    const minThumb = Math.min(trackHeight, this.measuredMinThumbPx);
    const contentRatio = scrollHeight > 0 ? clientHeight / scrollHeight : 1;
    const naturalThumbLength = nonNegativeFinite(trackHeight * contentRatio);
    const thumbLength = Math.min(trackHeight, Math.max(minThumb, naturalThumbLength));
    const travel = Math.max(0, trackHeight - thumbLength);
    const offset = maxScroll > 0 ? travel * clamp(scrollTop, 0, maxScroll) / maxScroll : 0;

    this.thumbLength = thumbLength;
    this.trackTravel = travel;
    thumb.style.height = `${thumbLength}px`;
    thumb.style.transform = `translateY(${nonNegativeFinite(offset)}px)`;
  }

  private measureMinimumThumb(): number {
    const probe = this.shadowRoot?.querySelector<HTMLElement>('[data-measure="thumb-min"]');

    if (!probe) {
      return DEFAULT_MIN_THUMB_PX;
    }

    const height = probe.getBoundingClientRect().height;

    return Number.isFinite(height) && height > 0 ? height : DEFAULT_MIN_THUMB_PX;
  }

  private setScrollFromThumbTop(top: number): void {
    const viewport = this.viewportElement;

    if (!viewport) {
      return;
    }

    const clampedTop = clamp(nonNegativeFinite(top), 0, this.trackTravel);
    const nextScrollTop = this.trackTravel > 0 ? this.maxScroll * clampedTop / this.trackTravel : 0;

    viewport.scrollTop = nonNegativeFinite(nextScrollTop);
    this.writeThumbOffset(clampedTop);
    this.scheduleRefresh(false);
  }

  private writeThumbOffset(offset: number): void {
    const thumb = this.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');

    if (thumb) {
      thumb.style.transform = `translateY(${nonNegativeFinite(offset)}px)`;
    }
  }

  private setDragging(dragging: boolean): void {
    const thumb = this.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');

    this.classList.toggle('dragging', dragging);
    thumb?.classList.toggle('dragging', dragging);
  }

  private endDrag(): void {
    if (!this.activeDrag) {
      this.setDragging(false);

      return;
    }

    const {pointerId, captureTarget} = this.activeDrag;

    captureTarget.releasePointerCapture?.(pointerId);

    this.activeDrag = null;
    this.setDragging(false);
  }

  private capturePointer(target: HTMLElement, pointerId: number): void {
    target.setPointerCapture?.(pointerId);
  }

  private readonly handleScroll = (): void => {
    this.scheduleRefresh(false);
  };

  private readonly handleResize = (): void => {
    this.scheduleRefresh(true);
  };

  private readonly handleSlotChange = (): void => {
    this.observeAssignedContent();
    this.scheduleRefresh(false);
  };

  private readonly handleThumbPointerDown = (event: PointerEvent): void => {
    const thumb = event.currentTarget as HTMLElement;
    const thumbRect = thumb.getBoundingClientRect();

    this.activeDrag = {
      pointerId: event.pointerId,
      offset: nonNegativeFinite(event.clientY - thumbRect.top),
      captureTarget: thumb,
    };
    this.capturePointer(thumb, event.pointerId);
    event.preventDefault();
    this.setDragging(true);
  };

  private readonly handleTrackPointerDown = (event: PointerEvent): void => {
    const thumb = this.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');

    if (event.target === thumb) {
      return;
    }

    const track = event.currentTarget as HTMLElement;
    const trackRect = track.getBoundingClientRect();
    const targetTop = event.clientY - trackRect.top - this.thumbLength / 2;

    this.setScrollFromThumbTop(targetTop);
    this.activeDrag = {
      pointerId: event.pointerId,
      offset: this.thumbLength / 2,
      captureTarget: track,
    };
    this.capturePointer(track, event.pointerId);
    event.preventDefault();
    this.setDragging(true);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.activeDrag?.pointerId !== event.pointerId) {
      return;
    }

    const desiredTop = event.clientY - this.trackTop - this.activeDrag.offset;

    this.setScrollFromThumbTop(desiredTop);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.activeDrag?.pointerId === event.pointerId) {
      this.endDrag();
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.activeDrag?.pointerId === event.pointerId) {
      this.endDrag();
    }
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-scroll-area': MndwScrollArea;
  }
}
