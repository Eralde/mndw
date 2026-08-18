import type {PluginI18n} from '@mndw/sdk';

export interface DnsLookupResult {
  hostname: string;
  addresses: string[];
  cname?: string;
  durationMs: number;
}

export const WIDGET_CLASS = 'mndw-dns-lookup-widget';

export type DnsErrorCode = 'empty-hostname' | 'lookup-failed';

export type DnsView =
  | {state: 'idle'}
  | {state: 'unavailable'}
  | {state: 'loading'; hostname: string}
  | {state: 'error'; code: DnsErrorCode}
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
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-atomic', 'true');

  if (view.state === 'loading') {
    root.setAttribute('aria-busy', 'true');
  } else {
    root.removeAttribute('aria-busy');
  }

  switch (view.state) {
    case 'idle': {
      const el = createEl(`${WIDGET_CLASS}__idle`, i18n.t('idle'));

      root.append(el);
      break;
    }
    case 'unavailable': {
      const el = createEl(`${WIDGET_CLASS}__unavailable`, i18n.t('unavailable'));

      root.append(el);
      break;
    }
    case 'loading': {
      const el = createEl(`${WIDGET_CLASS}__loading`, i18n.t('loading', {hostname: view.hostname}));

      root.append(el);
      break;
    }
    case 'error': {
      const message = view.code === 'empty-hostname' ? i18n.t('enter') : i18n.t('error.lookup-failed');
      const el = createEl('mndw-alert mndw-alert--danger', message);

      el.setAttribute('role', 'alert');
      root.append(el);
      break;
    }
    case 'not-found': {
      const el = createEl(`${WIDGET_CLASS}__not-found`, i18n.t('not-found', {hostname: view.hostname}));

      root.append(el);
      break;
    }
    case 'result': {
      const r = view.result;

      const el = document.createElement('div');

      el.className = `${WIDGET_CLASS}__result`;
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', i18n.t('result.label'));

      const hostname = createEl(`${WIDGET_CLASS}__result-hostname`, r.hostname);
      const duration = createEl(
        `${WIDGET_CLASS}__result-duration`,
        `${i18n.t('result.lookup-time')}: ${
          i18n.formatNumber(r.durationMs, {minimumFractionDigits: 1, maximumFractionDigits: 1})
        } ${i18n.t('result.lookup-time-unit')}`,
      );

      const addressesGroup = document.createElement('div');
      const addressesLabel = createEl(`${WIDGET_CLASS}__result-addresses-label`, i18n.t('result.addresses'));
      const addrList = document.createElement('ul');

      addressesGroup.className = `${WIDGET_CLASS}__result-addresses-group`;
      addrList.className = `${WIDGET_CLASS}__result-addresses`;

      for (const addr of r.addresses) {
        const li = document.createElement('li');

        li.className = `${WIDGET_CLASS}__result-addr`;
        li.textContent = addr;
        addrList.append(li);
      }

      addressesGroup.append(addressesLabel, addrList);
      el.append(hostname, duration, addressesGroup);

      if (r.cname !== undefined && r.cname !== `${r.hostname}.`) {
        const cname = createEl(`${WIDGET_CLASS}__result-cname`, `${i18n.t('result.cname')}: ${r.cname}`);

        el.append(cname);
      }

      root.append(el);
      break;
    }
  }
}
