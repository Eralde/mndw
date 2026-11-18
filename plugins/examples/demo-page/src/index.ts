import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';

export async function createInstance(el: HTMLElement, ctx: PluginContext): Promise<PluginInstance> {
  const i18n = ctx.i18n;
  const saved = await ctx.storage.instance.get('count');
  let count = saved ? parseInt(saved, 10) || 0 : 0;

  el.innerHTML = `
    <div
      class="demo-page"
      style="display: grid; gap: var(--mndw-space-3); padding: var(--mndw-space-4); font-family: var(--mndw-font-sans);"
    >
      <div class="demo-page__content" style="display: grid; gap: var(--mndw-space-2);">
        <div><b id="hello-page-instance-label"></b> ${ctx.instanceId}</div>

        <p id="hello-page-device"></p>
        <p id="hello-page-vendor"></p>
        <div id="hello-page-counter"></div>
        <div id="hello-page-stored"></div>
      </div>
      <div class="demo-page__actions">
        <mndw-button id="hello-page-save" variant="primary"></mndw-button>
      </div>
    </div>
  `;

  const instanceLabelEl = el.querySelector('#hello-page-instance-label');
  const deviceEl = el.querySelector('#hello-page-device');
  const vendorEl = el.querySelector('#hello-page-vendor');
  const counterEl = el.querySelector('#hello-page-counter');
  const storedEl = el.querySelector('#hello-page-stored');
  const saveBtn = el.querySelector('#hello-page-save');

  if (!instanceLabelEl || !deviceEl || !vendorEl || !counterEl || !storedEl || !saveBtn) {
    return {unmount() {}};
  }

  storedEl.textContent = saved ? `(restored from storage: ${saved})` : '';

  const render = (): void => {
    instanceLabelEl.textContent = i18n.t('instance-id');
    deviceEl.textContent = `${i18n.t('device')}: ${ctx.device.info.deviceName}`;
    vendorEl.textContent = `${i18n.t('vendor')}: ${ctx.device.info.vendor}`;
    counterEl.textContent = i18n.t('count', {count});
    saveBtn.textContent = i18n.t('save');
  };

  const unsubscribeLocale = bindLocale(i18n, render);

  const interval = setInterval(() => {
    count++;
    counterEl.textContent = i18n.t('count', {count});
  }, 1000);

  saveBtn.addEventListener('click', async () => {
    await ctx.storage.instance.set('count', String(count));
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
