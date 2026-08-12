// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import {useTranslator} from '@mndw/sdk/vue';
import {type App as VueApp, createApp, nextTick} from 'vue';
import CopyField from './CopyField.vue';

let host: HTMLElement;
let app: VueApp | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  vi.unstubAllGlobals();
});

describe('CopyField', () => {
  it('uses shared button and copies the field value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('navigator', {clipboard: {writeText}});
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(CopyField, {
      label: 'Serial',
      value: 'SN-123',
      translator: useTranslator(createTestI18n({copy: 'Copy', copied: 'Copied!'})),
    });
    app.mount(host);

    expect(host.querySelector('button')).toBeNull();

    const copyButton = host.querySelector<HTMLElement>('mndw-button');

    if (copyButton === null) {
      throw new Error('copy button was not rendered');
    }

    copyButton.click();
    await nextTick();
    await Promise.resolve();
    await nextTick();

    expect(writeText).toHaveBeenCalledWith('SN-123');
    expect(copyButton.textContent).toContain('Copied!');
  });
});
