import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';
import {type DnsLookupResult, type DnsView, render} from './render.js';

import './index.css';

const NAME = 'dns-lookup-widget';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  const i18n = context.i18n;

  container.replaceChildren();

  const rootEl = document.createElement('div');

  rootEl.className = `mndw-${NAME}`;

  const controls = document.createElement('div');

  controls.className = `mndw-${NAME}__controls`;

  const hostnameInput = document.createElement('input');

  hostnameInput.type = 'text';
  hostnameInput.className = `mndw-${NAME}__input`;
  hostnameInput.placeholder = i18n.t('hostname');

  const lookupBtn = document.createElement('button');

  lookupBtn.type = 'button';
  lookupBtn.className = `mndw-${NAME}__btn`;
  lookupBtn.textContent = i18n.t('lookup');

  controls.append(hostnameInput, lookupBtn);

  const resultEl = document.createElement('div');

  resultEl.className = `mndw-${NAME}__result`;

  const probeEl = document.createElement('span');

  probeEl.dataset.testid = 'l10n-probe';
  probeEl.hidden = true;

  rootEl.append(probeEl, controls, resultEl);
  container.append(rootEl);

  let currentView: DnsView = {state: 'idle'};

  const renderView = (view: DnsView): void => {
    currentView = view;
    render(resultEl, view, i18n);
  };

  const renderLocale = (): void => {
    probeEl.textContent = i18n.t('l10n.probe');
    hostnameInput.placeholder = i18n.t('hostname');
    lookupBtn.textContent = i18n.t('lookup');
    render(resultEl, currentView, i18n);
  };

  const unsubscribeLocale = bindLocale(i18n, renderLocale);

  function displayError(message: string): void {
    renderView({state: 'error', message});
  }

  async function doLookup(): Promise<void> {
    const hostname = hostnameInput.value.trim();
    const backend = context.backend;

    if (hostname === '') {
      displayError(i18n.t('enter'));

      return;
    }

    if (backend === undefined) {
      renderView({state: 'unavailable'});

      return;
    }

    hostnameInput.disabled = true;
    lookupBtn.disabled = true;
    renderView({state: 'loading', hostname});

    try {
      const response = await backend.fetch('lookup', {query: {hostname}});
      const payload = (await response.json()) as DnsLookupResult & {success?: boolean; error?: string};

      if (payload.error === 'NXDOMAIN') {
        renderView({state: 'not-found', hostname});

        return;
      }

      if (payload.success === false || payload.error !== undefined) {
        displayError(payload.error ?? 'Backend returned an error');

        return;
      }

      if (payload.addresses === undefined || payload.addresses.length === 0) {
        renderView({state: 'not-found', hostname});

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

      renderView(resultView);
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
      unsubscribeLocale();
      container.replaceChildren();
    },
  };
}
