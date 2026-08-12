import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';
import {Ticker} from '@mndw/sdk/ticker';

/**
 * Minimal vanilla widget: a live ticking clock rendered with plain DOM against host tokens.
 * No framework, no backend, no RCI — the vanilla tile for the four-framework dashboard and a
 * clean mount/unmount reference.
 */
export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  const i18n = ctx.i18n;
  const containerStyle = `
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    font-family: var(--mndw-font-mono, sans-serif);
    color: var(--mndw-text-subtle);
  `;

  const timeStyle = `
    font-size: 2rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `;

  el.innerHTML = `
    <div style="${containerStyle}">
      <span data-testid="l10n-probe" hidden></span>
      <time data-mndw-clock style="${timeStyle}"></time>
    </div>
  `;

  const timeEl = el.querySelector<HTMLTimeElement>('[data-mndw-clock]');
  const probeEl = el.querySelector<HTMLElement>('[data-testid="l10n-probe"]');

  const render = (): void => {
    if (timeEl) {
      if (probeEl) {
        probeEl.textContent = i18n.t('l10n.probe');
      }
      timeEl.textContent = i18n.formatDate(new Date(), {timeStyle: 'medium'});
      timeEl.setAttribute('aria-label', i18n.t('title'));
    }
  };

  const unsubscribeLocale = bindLocale(i18n, render);

  const ticker = new Ticker();
  const unsubscribe = ticker.onTick(() => {
    render();
  });
  ticker.start(1000);

  return {
    unmount(): void {
      unsubscribe();
      unsubscribeLocale();
      ticker.destroy();

      el.innerHTML = '';
    },
  };
}
