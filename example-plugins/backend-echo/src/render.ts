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

export function render(root: HTMLElement, view: EchoView): void {
  root.replaceChildren();

  const el = document.createElement('div');

  switch (view.state) {
    case 'idle':
      el.className = 'mndw-echo__idle';
      el.textContent = 'Press GET or POST to call the backend.';
      break;
    case 'pending':
      el.className = 'mndw-echo__pending';
      el.textContent = 'Backend is pending approval — approve it in Settings, then retry.';
      break;
    case 'disabled':
      el.className = 'mndw-echo__disabled';
      el.textContent = 'Backend is disabled — enable it in Settings, then retry.';
      break;
    case 'unavailable':
      el.className = 'mndw-echo__unavailable';
      el.textContent = 'This plugin has no backend available.';
      break;
    case 'error':
      el.className = 'mndw-echo__error';
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
