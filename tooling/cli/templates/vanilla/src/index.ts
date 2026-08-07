import type {PluginContext, PluginInstance} from '@mndw/sdk';

import './index.css';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  container.innerHTML = `
    <div class="mndw-__MNDW_NAME__">
      <h3 class="mndw-__MNDW_NAME____title">__MNDW_LABEL__</h3>
      <p class="mndw-__MNDW_NAME____device">Device: <span class="mndw-__MNDW_NAME____device-name"></span></p>
      <button class="mndw-__MNDW_NAME____count" type="button">Clicked 0</button>
    </div>
  `;

  const deviceEl = container.querySelector('.mndw-__MNDW_NAME____device-name');
  const button = container.querySelector('.mndw-__MNDW_NAME____count');

  if (deviceEl !== null) {
    deviceEl.textContent = ctx.hostInfo.deviceName;
  }

  let count = 0;
  const onClick = (): void => {
    count++;

    if (button !== null) {
      button.textContent = `Clicked ${count}`;
    }
  };

  button?.addEventListener('click', onClick);

  return {
    unmount() {
      button?.removeEventListener('click', onClick);

      container.innerHTML = '';
    },
  };
}
