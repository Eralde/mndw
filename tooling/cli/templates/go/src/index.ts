import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';

import './index.css';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  container.innerHTML = `
    <div class="mndw-__MNDW_NAME__">
      <h3 class="mndw-__MNDW_NAME____title" data-testid="l10n-probe" data-plugin-label="__MNDW_LABEL__"></h3>
      <p class="mndw-__MNDW_NAME____device">Device: <span class="mndw-__MNDW_NAME____device-name"></span></p>
      <button class="mndw-__MNDW_NAME____count" type="button"></button>
      <p class="mndw-__MNDW_NAME____result" data-testid="l10n-result"></p>
    </div>
  `;

  const title = container.querySelector('.mndw-__MNDW_NAME____title');
  const device = container.querySelector('.mndw-__MNDW_NAME____device-name');
  const button = container.querySelector('.mndw-__MNDW_NAME____count');
  const result = container.querySelector('.mndw-__MNDW_NAME____result');
  let mounted = true;
  let backendMessage: string | undefined;
  let backendError = false;

  const render = (): void => {
    if (title !== null) {
      title.textContent = ctx.i18n.t('l10n.probe');
    }

    if (device !== null) {
      device.textContent = ctx.deviceInfo.deviceName;
    }

    if (button !== null) {
      button.textContent = ctx.i18n.t('l10n.button');
    }

    if (result === null) {
      return;
    }

    if (backendError) {
      result.textContent = ctx.i18n.t('l10n.error');
    } else if (backendMessage !== undefined) {
      result.textContent = `${ctx.i18n.t('l10n.result')}: ${backendMessage}`;
    } else {
      result.textContent = ctx.i18n.t('l10n.result');
    }
  };

  const load = async (): Promise<void> => {
    if (ctx.backend === undefined) {
      render();
      return;
    }

    try {
      const response = await ctx.backend.fetch('hello');
      const data = await response.json() as {message: string; plugin: string};
      backendMessage = data.message;
      backendError = false;
    } catch {
      backendMessage = undefined;
      backendError = true;
    }

    if (mounted) {
      render();
    }
  };

  const onClick = (): void => {
    void load();
  };

  button?.addEventListener('click', onClick);
  const teardown = bindLocale(ctx.i18n, render);
  const themeSubscription = ctx.theme$.subscribe((theme) => {
    container.dataset.theme = theme;
  });
  void load();

  return {
    unmount() {
      mounted = false;
      teardown();
      themeSubscription.unsubscribe();
      button?.removeEventListener('click', onClick);
      container.innerHTML = '';
      delete container.dataset.theme;
    },
  };
}
