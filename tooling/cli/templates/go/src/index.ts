import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';

import './index.css';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const rootTag = ctx.kind === 'page' ? 'section' : 'div';
  const heading = ctx.kind === 'page' ? '<h2 id="plugin-title" class="mndw-__MNDW_NAME____title"></h2>' : '';
  const labelledBy = ctx.kind === 'page' ? 'aria-labelledby="plugin-title"' : '';

  container.innerHTML = `
    <${rootTag} class="__MNDW_NAME__" ${labelledBy}>
      ${heading}
      <p class="mndw-__MNDW_NAME____device">Device: <span class="mndw-__MNDW_NAME____device-name"></span></p>
      <mndw-button class="mndw-__MNDW_NAME____button" variant="primary" type="button"></mndw-button>
      <p class="mndw-__MNDW_NAME____result" data-testid="l10n-result"></p>
    </${rootTag}>
  `;

  const title = container.querySelector('.mndw-__MNDW_NAME____title');
  const device = container.querySelector('.mndw-__MNDW_NAME____device-name');
  const button = container.querySelector('.mndw-__MNDW_NAME____button');
  const result = container.querySelector('.mndw-__MNDW_NAME____result');
  let mounted = true;
  let backendMessage: string | undefined;
  let backendError = false;

  const render = (): void => {
    if (title !== null) {
      title.textContent = ctx.i18n.t('l10n.title');
    }

    if (ctx.kind === 'widget') {
      ctx.setTileTitle?.(ctx.i18n.t('l10n.title'));
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
      backendError = true;
      render();

      return;
    }

    try {
      const response = await ctx.backend.call<{message: string}>('hello', {as: 'json'});
      backendMessage = response.message;
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

  return {
    unmount() {
      mounted = false;
      teardown();
      button?.removeEventListener('click', onClick);
      container.innerHTML = '';
    },
  };
}
