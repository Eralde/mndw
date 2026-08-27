import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';
import type {MndwButton, MndwInput} from '@mndw/ui';
import {type DnsErrorCode, type DnsLookupResult, type DnsView, WIDGET_CLASS, render} from './render.js';

import './index.css';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  const i18n = context.i18n;

  container.replaceChildren();

  const rootEl = document.createElement('div');

  rootEl.className = WIDGET_CLASS;

  const controls = document.createElement('form');

  controls.className = `${WIDGET_CLASS}__controls`;

  const field = document.createElement('div');

  field.className = `${WIDGET_CLASS}__field`;

  const fieldLabel = document.createElement('label');

  fieldLabel.className = `${WIDGET_CLASS}__label`;
  fieldLabel.htmlFor = `${WIDGET_CLASS}__hostname`;
  fieldLabel.textContent = i18n.t('hostname-label');

  const hostnameInput: MndwInput = document.createElement('mndw-input');

  hostnameInput.type = 'text';
  hostnameInput.id = `${WIDGET_CLASS}__hostname`;
  hostnameInput.name = 'hostname';
  hostnameInput.className = `${WIDGET_CLASS}__input`;
  hostnameInput.placeholder = i18n.t('hostname');

  const hostnameHint = document.createElement('span');

  hostnameHint.className = `${WIDGET_CLASS}__hint`;
  hostnameHint.id = `${WIDGET_CLASS}__hostname-hint`;
  hostnameHint.textContent = i18n.t('hostname-hint');
  hostnameInput.setAttribute('aria-describedby', hostnameHint.id);

  const controlRow = document.createElement('div');

  controlRow.className = `${WIDGET_CLASS}__control-row`;

  const lookupBtn: MndwButton = document.createElement('mndw-button');

  lookupBtn.type = 'submit';
  lookupBtn.variant = 'primary';
  lookupBtn.className = `${WIDGET_CLASS}__btn`;
  lookupBtn.textContent = i18n.t('lookup');

  controlRow.append(hostnameInput, lookupBtn);
  field.append(fieldLabel, controlRow, hostnameHint);
  controls.append(field);

  const resultEl = document.createElement('div');

  resultEl.className = `${WIDGET_CLASS}__result`;

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
    fieldLabel.textContent = i18n.t('hostname-label');
    hostnameInput.placeholder = i18n.t('hostname');
    hostnameHint.textContent = i18n.t('hostname-hint');
    lookupBtn.textContent = i18n.t('lookup');
    render(resultEl, currentView, i18n);
  };

  const unsubscribeLocale = bindLocale(i18n, renderLocale);

  function displayError(code: DnsErrorCode): void {
    renderView({state: 'error', code});
  }

  async function doLookup(): Promise<void> {
    const hostname = hostnameInput.value.trim();
    const backend = context.backend;

    if (hostname === '') {
      displayError('empty-hostname');

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
        displayError('lookup-failed');

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
    } catch {
      displayError('lookup-failed');
    } finally {
      hostnameInput.disabled = false;
      lookupBtn.disabled = false;
    }
  }

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    void doLookup();
  };

  controls.addEventListener('submit', onSubmit);

  return {
    unmount(): void {
      controls.removeEventListener('submit', onSubmit);
      unsubscribeLocale();
      container.replaceChildren();
    },
  };
}
