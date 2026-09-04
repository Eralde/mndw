// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type App as VueApp, createApp} from 'vue';
import {createTestI18n} from '@mndw/sdk/testing';
import {useTranslator} from '@mndw/sdk/vue';
import SectionSettings from './SectionSettings.vue';

type MndwCheckboxHost = HTMLElement & {checked: boolean};

let host: HTMLElement;
let app: VueApp | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
});

function mountSettings(onChange: ReturnType<typeof vi.fn>): void {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(SectionSettings, {
    visibility: {cpu: true, ram: false, identity: true},
    onChange,
    translator: useTranslator(createTestI18n({
      sections: 'Sections',
      cpu: 'CPU',
      ram: 'RAM',
      identity: 'Identity',
    })),
  });
  app.mount(host);
}

describe('SectionSettings', () => {
  it('renders all section visibility controls', () => {
    mountSettings(vi.fn());

    expect(host.querySelectorAll('mndw-checkbox')).toHaveLength(3);
    expect(host.textContent).toContain('Sections');
  });

  it('forwards checkbox changes using section keys', () => {
    const onChange = vi.fn();

    mountSettings(onChange);

    const checkbox = host.querySelector<MndwCheckboxHost>('mndw-checkbox');

    if (checkbox === null) {
      throw new Error('section checkbox was not rendered');
    }

    checkbox.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: false, indeterminate: false},
      }),
    );

    expect(onChange).toHaveBeenCalledWith('cpu', false);
  });
});
