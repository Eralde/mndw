import type {PluginContext, PluginInstance} from '@mndw/sdk';

export async function createInstance(el: HTMLElement, ctx: PluginContext): Promise<PluginInstance> {
  el.innerHTML = `
    <div style="padding: 24px; font-family: sans-serif;">
      <div><b>Plugin instance id:</b> ${ctx.instanceId}</div><br/>

      <h2>Hello Page Plugin</h2>
      <p>Device: ${ctx.hostInfo.deviceName}</p>
      <p>Vendor: ${ctx.hostInfo.vendor}</p>
      <div id="hello-page-counter">Count: 0</div>
      <mndw-button id="hello-page-save" variant="primary">Save count</mndw-button>
      <div id="hello-page-stored"></div>
    </div>
  `;

  let count = 0;
  const saved = await ctx.storage.get('count');

  if (saved) { count = parseInt(saved, 10) || 0; }

  const counterEl = el.querySelector('#hello-page-counter');
  const storedEl = el.querySelector('#hello-page-stored');
  const saveBtn = el.querySelector('#hello-page-save');

  if (!counterEl || !storedEl || !saveBtn) { return {unmount() {}}; }

  counterEl.textContent = `Count: ${count}`;
  storedEl.textContent = saved ? `(restored from storage: ${saved})` : '';

  const interval = setInterval(() => {
    count++;
    counterEl.textContent = `Count: ${count}`;
  }, 1000);

  saveBtn.addEventListener('click', async () => {
    await ctx.storage.set('count', String(count));
    storedEl.textContent = `(saved: ${count})`;
  });

  return {
    unmount() {
      clearInterval(interval);
      el.innerHTML = '';
    },
  };
}
