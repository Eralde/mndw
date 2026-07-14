import type {PluginContext, PluginInstance} from '@mndw/sdk';

/**
 * Minimal vanilla widget: a live ticking clock rendered with plain DOM against host tokens.
 * No framework, no backend, no RCI — the vanilla tile for the four-framework dashboard and a
 * clean mount/unmount reference.
 */
export function createInstance(el: HTMLElement, _ctx: PluginContext): PluginInstance {
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
      <time data-mndw-clock style="${timeStyle}"></time>
    </div>
  `;

  const timeEl = el.querySelector<HTMLTimeElement>('[data-mndw-clock]');

  const render = (): void => {
    if (timeEl) {
      timeEl.textContent = new Date().toLocaleTimeString();
    }
  };

  render();

  const interval = setInterval(render, 1000);

  return {
    unmount(): void {
      clearInterval(interval);
      el.innerHTML = '';
    },
  };
}
