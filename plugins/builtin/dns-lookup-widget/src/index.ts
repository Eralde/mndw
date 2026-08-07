import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {type DnsLookupResult, type DnsView, render} from './render.js';

import './index.css';

const NAME = 'dns-lookup-widget';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  container.replaceChildren();

  const rootEl = document.createElement('div');

  rootEl.className = `mndw-${NAME}`;

  const controls = document.createElement('div');

  controls.className = `mndw-${NAME}__controls`;

  const hostnameInput = document.createElement('input');

  hostnameInput.type = 'text';
  hostnameInput.className = `mndw-${NAME}__input`;
  hostnameInput.placeholder = 'Hostname (e.g. google.com)';

  const lookupBtn = document.createElement('button');

  lookupBtn.type = 'button';
  lookupBtn.className = `mndw-${NAME}__btn`;
  lookupBtn.textContent = 'Lookup';

  controls.append(hostnameInput, lookupBtn);

  const resultEl = document.createElement('div');

  resultEl.className = `mndw-${NAME}__result`;

  rootEl.append(controls, resultEl);
  container.append(rootEl);

  render(resultEl, {state: 'idle'});

  function displayError(message: string): void {
    render(resultEl, {state: 'error', message});
  }

  async function doLookup(): Promise<void> {
    const hostname = hostnameInput.value.trim();
    const backend = context.backend;

    if (hostname === '') {
      displayError('Please enter a hostname.');

      return;
    }

    if (backend === undefined) {
      render(resultEl, {state: 'unavailable'});

      return;
    }

    hostnameInput.disabled = true;
    lookupBtn.disabled = true;
    render(resultEl, {state: 'loading', hostname});

    try {
      const response = await backend.fetch('lookup', {query: {hostname}});
      const payload = (await response.json()) as DnsLookupResult & {success?: boolean; error?: string};

      if (payload.error === 'NXDOMAIN') {
        render(resultEl, {state: 'not-found', hostname});

        return;
      }

      if (payload.success === false || payload.error !== undefined) {
        displayError(payload.error ?? 'Backend returned an error');

        return;
      }

      if (payload.addresses === undefined || payload.addresses.length === 0) {
        render(resultEl, {state: 'not-found', hostname});

        return;
      }

      const resultView: DnsView = {
        state: 'result',
        result: {
          hostname: payload.hostname ?? hostname,
          addresses: payload.addresses,
          cname: payload.cname,
          durationMs: payload.durationMs ?? 0,
        },
      };

      render(resultEl, resultView);
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
    } finally {
      hostnameInput.disabled = false;
      lookupBtn.disabled = false;
    }
  }

  const onClick = (): void => {
    void doLookup();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      void doLookup();
    }
  };

  lookupBtn.addEventListener('click', onClick);
  hostnameInput.addEventListener('keydown', onKeydown);

  return {
    unmount(): void {
      lookupBtn.removeEventListener('click', onClick);
      hostnameInput.removeEventListener('keydown', onKeydown);
      container.replaceChildren();
    },
  };
}
