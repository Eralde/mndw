import {BackendDisabled, BackendNotApproved, type PluginContext} from '@mndw/sdk';
import {type EchoView, render} from './render.js';

type Backend = PluginContext['backend'];

export interface EchoWidget {
  unmount(): void;
}

export function mountEchoWidget(container: HTMLElement, backend: Backend): EchoWidget {
  container.replaceChildren();

  const rootEl = document.createElement('div');

  rootEl.className = 'mndw-echo';

  const controls = document.createElement('div');

  controls.className = 'mndw-echo__controls';

  const statusInput = document.createElement('input');

  statusInput.type = 'number';
  statusInput.className = 'mndw-echo__status-input';
  statusInput.placeholder = 'status';

  const getBtn = document.createElement('button');

  getBtn.className = 'mndw-echo__get';
  getBtn.textContent = 'GET /echo';

  const postBtn = document.createElement('button');

  postBtn.className = 'mndw-echo__post';
  postBtn.textContent = 'POST /echo';

  controls.append(statusInput, getBtn, postBtn);

  const resultEl = document.createElement('div');

  resultEl.className = 'mndw-echo__result';

  rootEl.append(controls, resultEl);
  container.append(rootEl);

  render(resultEl, {state: 'idle'});

  async function call(id: 'echoGet' | 'echoPost', withBody: boolean): Promise<void> {
    if (!backend) {
      render(resultEl, {state: 'unavailable'});

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

      render(resultEl, view);
    } catch (error) {
      if (error instanceof BackendNotApproved) {
        render(resultEl, {state: 'pending'});

        return;
      }

      if (error instanceof BackendDisabled) {
        render(resultEl, {state: 'disabled'});

        return;
      }

      render(resultEl, {state: 'error', message: error instanceof Error ? error.message : String(error)});
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
      container.replaceChildren();
    },
  };
}
