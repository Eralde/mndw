import type {PluginI18n} from '@mndw/sdk';

export interface DnsLookupResult {
  hostname: string;
  addresses: string[];
  cname?: string;
  durationMs: number;
}

export type DnsView =
  | {state: 'idle'}
  | {state: 'unavailable'}
  | {state: 'loading'; hostname: string}
  | {state: 'error'; message: string}
  | {state: 'not-found'; hostname: string}
  | {state: 'result'; result: DnsLookupResult};

function createEl(className: string, text: string): HTMLDivElement {
  const el = document.createElement('div');

  el.className = className;
  el.textContent = text;

  return el;
}

export function render(root: HTMLElement, view: DnsView, i18n: PluginI18n): void {
  root.replaceChildren();

  const NAME = 'dns-lookup-widget';

  switch (view.state) {
    case 'idle': {
      const el = createEl(`${NAME}__idle`, i18n.t('idle'));

      root.append(el);
      break;
    }
    case 'unavailable': {
      const el = createEl(`${NAME}__unavailable`, i18n.t('unavailable'));

      root.append(el);
      break;
    }
    case 'loading': {
      const el = createEl(`${NAME}__loading`, i18n.t('loading', {hostname: view.hostname}));

      root.append(el);
      break;
    }
    case 'error': {
      const el = createEl('mndw-alert mndw-alert--danger', `Lookup failed: ${view.message}`);

      el.setAttribute('role', 'alert');
      root.append(el);
      break;
    }
    case 'not-found': {
      const el = createEl(`${NAME}__not-found`, i18n.t('not-found', {hostname: view.hostname}));

      root.append(el);
      break;
    }
    case 'result': {
      const r = view.result;

      const el = document.createElement('div');

      el.className = `${NAME}__result`;

      const hostname = createEl(`${NAME}__result-hostname`, r.hostname);
      const duration = createEl(
        `${NAME}__result-duration`,
        `${i18n.formatNumber(r.durationMs, {minimumFractionDigits: 1, maximumFractionDigits: 1})} ms`,
      );

      const addrList = document.createElement('ul');

      addrList.className = `${NAME}__result-addresses`;

      for (const addr of r.addresses) {
        const li = document.createElement('li');

        li.className = `${NAME}__result-addr`;
        li.textContent = addr;
        addrList.append(li);
      }

      el.append(hostname, duration, addrList);

      if (r.cname !== undefined && r.cname !== `${r.hostname}.`) {
        const cname = createEl(`${NAME}__result-cname`, `CNAME: ${r.cname}`);

        el.append(cname);
      }

      root.append(el);
      break;
    }
  }
}
