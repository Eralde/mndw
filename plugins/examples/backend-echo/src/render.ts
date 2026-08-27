import type {PluginI18n} from '@mndw/sdk';

export interface EchoResult {
  httpStatus: number;
  echoHeader: string | null;
  payload: unknown;
}

export type EchoView =
  | {state: 'idle'}
  | {state: 'pending'}
  | {state: 'disabled'}
  | {state: 'unavailable'}
  | {state: 'error'; message: string}
  | {state: 'result'; result: EchoResult};

export function render(root: HTMLElement, view: EchoView, i18n: PluginI18n): void {
  root.replaceChildren();

  const el = document.createElement('div');

  switch (view.state) {
    case 'idle':
      el.className = 'mndw-echo__idle';
      el.textContent = i18n.t('idle');
      break;
    case 'pending':
      el.className = 'mndw-echo__pending';
      el.textContent = i18n.t('pending');
      break;
    case 'disabled':
      el.className = 'mndw-echo__disabled';
      el.textContent = i18n.t('disabled');
      break;
    case 'unavailable':
      el.className = 'mndw-echo__unavailable';
      el.textContent = i18n.t('unavailable');
      break;
    case 'error':
      el.className = 'mndw-alert mndw-alert--danger';
      el.setAttribute('role', 'alert');
      el.textContent = `Request failed: ${view.message}`;
      break;
    case 'result': {
      el.className = 'mndw-echo__result-view';

      const status = document.createElement('p');

      status.className = 'mndw-echo__status';
      status.textContent = `HTTP ${view.result.httpStatus} · X-Mndw-Echo: ${view.result.echoHeader ?? '(absent)'}`;

      const pre = document.createElement('pre');

      pre.className = 'mndw-echo__body';
      pre.textContent = typeof view.result.payload === 'string'
        ? view.result.payload
        : JSON.stringify(view.result.payload, null, 2);

      el.append(status, pre);
      break;
    }
  }

  root.append(el);
}
