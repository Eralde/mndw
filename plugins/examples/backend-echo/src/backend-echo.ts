import {BackendDisabled, BackendNotApproved, type PluginContext, type PluginI18n} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';
import type {MndwButton, MndwInput} from '@mndw/ui';
import {type EchoView, render} from './render.js';

type Backend = PluginContext['backend'];

export interface EchoWidget {
  unmount(): void;
}

export function mountEchoWidget(container: HTMLElement, backend: Backend, i18n: PluginI18n): EchoWidget {
  container.replaceChildren();

  const rootEl = document.createElement('div');

  rootEl.className = 'mndw-echo';

  const controls = document.createElement('div');

  controls.className = 'mndw-echo__controls';

  const statusInput: MndwInput = document.createElement('mndw-input');

  statusInput.type = 'number';
  statusInput.className = 'mndw-echo__status-input';
  statusInput.placeholder = i18n.t('status');

  const getBtn: MndwButton = document.createElement('mndw-button');

  getBtn.className = 'mndw-echo__get';
  getBtn.variant = 'primary';
  getBtn.textContent = i18n.t('get');

  const postBtn: MndwButton = document.createElement('mndw-button');

  postBtn.className = 'mndw-echo__post';
  postBtn.variant = 'secondary';
  postBtn.textContent = i18n.t('post');

  controls.append(statusInput, getBtn, postBtn);

  const resultEl = document.createElement('div');

  resultEl.className = 'mndw-echo__result';

  const probeEl = document.createElement('span');

  probeEl.dataset.testid = 'l10n-probe';
  probeEl.hidden = true;

  rootEl.append(probeEl, controls, resultEl);
  container.append(rootEl);

  let currentView: EchoView = {state: 'idle'};

  const renderView = (view: EchoView): void => {
    currentView = view;
    render(resultEl, view, i18n);
  };

  const renderLocale = (): void => {
    probeEl.textContent = i18n.t('l10n.probe');
    statusInput.placeholder = i18n.t('status');
    getBtn.textContent = i18n.t('get');
    postBtn.textContent = i18n.t('post');
    render(resultEl, currentView, i18n);
  };

  const unsubscribeLocale = bindLocale(i18n, renderLocale);

  async function call(id: 'echoGet' | 'echoPost', withBody: boolean): Promise<void> {
    if (!backend) {
      renderView({state: 'unavailable'});

      return;
    }

    const statusValue = statusInput.value.trim();
    const query = statusValue === '' ? undefined : {status: statusValue};
    const body = withBody ? {hi: 1} : undefined;

    try {
      const response = await backend.fetch(id, {query, body});
      const text = await response.text();
      let payload: unknown;

      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }

      const view: EchoView = {
        state: 'result',
        result: {
          httpStatus: response.status,
          echoHeader: response.headers.get('X-Mndw-Echo'),
          payload,
        },
      };

      renderView(view);
    } catch (error) {
      if (error instanceof BackendNotApproved) {
        renderView({state: 'pending'});

        return;
      }

      if (error instanceof BackendDisabled) {
        renderView({state: 'disabled'});

        return;
      }

      renderView({state: 'error', message: error instanceof Error ? error.message : String(error)});
    }
  }

  const onGet = (): void => {
    void call('echoGet', false);
  };
  const onPost = (): void => {
    void call('echoPost', true);
  };

  getBtn.addEventListener('click', onGet);
  postBtn.addEventListener('click', onPost);

  return {
    unmount(): void {
      getBtn.removeEventListener('click', onGet);
      postBtn.removeEventListener('click', onPost);
      unsubscribeLocale();
      container.replaceChildren();
    },
  };
}
