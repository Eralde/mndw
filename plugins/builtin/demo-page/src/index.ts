import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';

export async function createInstance(el: HTMLElement, ctx: PluginContext): Promise<PluginInstance> {
  const i18n = ctx.i18n;
  const saved = await ctx.storage.get('count');
  let count = saved ? parseInt(saved, 10) || 0 : 0;

  el.innerHTML = `
    <div style="padding: 24px; font-family: sans-serif;">
      <div><b id="hello-page-instance-label"></b> ${ctx.instanceId}</div><br/>

      <h2 data-testid="l10n-probe"></h2>
      <p id="hello-page-device"></p>
      <p id="hello-page-vendor"></p>
      <div id="hello-page-counter"></div>
      <mndw-button id="hello-page-save" variant="primary"></mndw-button>
      <div id="hello-page-stored"></div>
    </div>
  `;

  const instanceLabelEl = el.querySelector('#hello-page-instance-label');
  const titleEl = el.querySelector<HTMLElement>('[data-testid="l10n-probe"]');
  const deviceEl = el.querySelector('#hello-page-device');
  const vendorEl = el.querySelector('#hello-page-vendor');
  const counterEl = el.querySelector('#hello-page-counter');
  const storedEl = el.querySelector('#hello-page-stored');
  const saveBtn = el.querySelector('#hello-page-save');

  if (!instanceLabelEl || !titleEl || !deviceEl || !vendorEl || !counterEl || !storedEl || !saveBtn) {
    return {unmount() {}};
  }

  storedEl.textContent = saved ? `(restored from storage: ${saved})` : '';

  const render = (): void => {
    instanceLabelEl.textContent = i18n.t('instance-id');
    titleEl.textContent = i18n.t('l10n.probe');
    deviceEl.textContent = `${i18n.t('device')}: ${ctx.hostInfo.deviceName}`;
    vendorEl.textContent = `${i18n.t('vendor')}: ${ctx.hostInfo.vendor}`;
    counterEl.textContent = i18n.t('count', {count});
    saveBtn.textContent = i18n.t('save');
  };

  const unsubscribeLocale = bindLocale(i18n, render);

  const interval = setInterval(() => {
    count++;
    counterEl.textContent = i18n.t('count', {count});
  }, 1000);

  saveBtn.addEventListener('click', async () => {
    await ctx.storage.set('count', String(count));
    storedEl.textContent = `(saved: ${count})`;
  });

  return {
    unmount() {
      unsubscribeLocale();
      clearInterval(interval);
      el.innerHTML = '';
    },
  };
}
