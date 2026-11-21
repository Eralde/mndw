import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';

export const MNDW_PROGRESS_TAG = 'mndw-progress';

const DEFAULT_MAX = 100;

/** Width of the sliding bar while indeterminate, as the `.mndw-progress` class draws it. */
const INDETERMINATE_BAR_WIDTH = 40;

/**
 * Progress bar whose ARIA lives in `ElementInternals`, so the bar and its `aria-value*` cannot drift.
 * Without a finite `value` it is indeterminate, like the `.mndw-progress` class.
 */
export class MndwProgress extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    value: {type: Number},
    max: {type: Number},
    label: {type: String},
  };

  public static override readonly styles = css`
    :host {
      box-sizing: border-box;
      display: block;
      width: 100%;
    }

    [part='track'] {
      overflow: hidden;
      height: var(--mndw-space-1);
      border-radius: var(--mndw-radius-sm);
      background: var(--mndw-surface-raised);
    }

    [part='bar'] {
      height: 100%;
      border-radius: inherit;
      background: var(--mndw-accent);
    }

    [part='bar'].determinate {
      transition: width var(--mndw-duration-base) var(--mndw-easing);
    }

    [part='bar'].indeterminate {
      width: ${INDETERMINATE_BAR_WIDTH}%;
      animation: mndw-progress-bar 1.35s ease-in-out infinite alternate;
    }

    @media (prefers-reduced-motion: reduce) {
      [part='bar'].determinate {
        transition: none;
      }

      [part='bar'].indeterminate {
        animation-duration: 3s;
      }
    }

    @keyframes mndw-progress-bar {
      from {
        transform: translateX(-100%);
      }

      to {
        transform: translateX(250%);
      }
    }
  `;

  declare public value: number;
  declare public max: number;
  declare public label: string;

  private readonly internals: ElementInternals | null;

  constructor() {
    super();
    this.value = Number.NaN;
    this.max = DEFAULT_MAX;
    this.label = '';
    this.internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null;
  }

  protected override willUpdate(): void {
    this.syncAria();
  }

  protected override render(): TemplateResult {
    if (!this.hasValue) {
      return html`
        <div part="track"><div part="bar" class="indeterminate"></div></div>
      `;
    }

    return html`
      <div part="track">
        <div part="bar" class="determinate" style="width: ${this.percent}%"></div>
      </div>
    `;
  }

  /** A zero, negative, or non-numeric `max` cannot describe a ratio, so it falls back to the default. */
  private get effectiveMax(): number {
    return Number.isFinite(this.max) && this.max > 0 ? this.max : DEFAULT_MAX;
  }

  private get hasValue(): boolean {
    return Number.isFinite(this.value);
  }

  private get clampedValue(): number {
    return Math.min(Math.max(this.value, 0), this.effectiveMax);
  }

  private get percent(): number {
    return this.hasValue ? (this.clampedValue / this.effectiveMax) * 100 : 0;
  }

  private syncAria(): void {
    const internals = this.internals;

    if (!internals) {
      return;
    }

    internals.role = 'progressbar';
    internals.ariaLabel = this.label || null;

    if (!this.hasValue) {
      internals.ariaValueNow = null;
      internals.ariaValueMin = null;
      internals.ariaValueMax = null;
      internals.ariaBusy = 'true';

      return;
    }

    internals.ariaValueNow = String(this.clampedValue);
    internals.ariaValueMin = '0';
    internals.ariaValueMax = String(this.effectiveMax);
    internals.ariaBusy = null;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-progress': MndwProgress;
  }
}
