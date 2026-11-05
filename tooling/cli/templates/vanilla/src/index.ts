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
  const deviceEl = container.querySelector('.mndw-__MNDW_NAME____device-name');
  const button = container.querySelector('.mndw-__MNDW_NAME____count');
  const result = container.querySelector('.mndw-__MNDW_NAME____result');

  let count = 0;

  const render = (): void => {
    if (title !== null) {
      title.textContent = ctx.i18n.t('l10n.probe');
    }

    if (deviceEl !== null) {
      deviceEl.textContent = ctx.deviceInfo.deviceName;
    }

    if (button !== null) {
      button.textContent = ctx.i18n.t('l10n.button');
    }

    if (result !== null) {
      result.textContent = ctx.i18n.t('l10n.result');
    }
  };

  const onClick = (): void => {
    count++;

    if (result !== null) {
      result.textContent = `${ctx.i18n.t('l10n.result')} ${count}`;
    }
  };

  button?.addEventListener('click', onClick);
  const teardown = bindLocale(ctx.i18n, render);
  const themeSubscription = ctx.theme$.subscribe((theme) => {
    container.dataset.theme = theme;
  });

  return {
    unmount() {
      teardown();
      themeSubscription.unsubscribe();
      button?.removeEventListener('click', onClick);

      container.innerHTML = '';
      delete container.dataset.theme;
    },
  };
}
