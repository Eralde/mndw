// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {flushSync} from 'svelte';

import {mountStandaloneOverlay} from './standalone-overlay.js';

describe('mountStandaloneOverlay', () => {
  let destroy: (() => void) | undefined;

  afterEach(() => {
    destroy?.();
    destroy = undefined;
    document.body.innerHTML = '';
  });

  it('mounts the host shell for service layers and removes it on destroy', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const standalone = mountStandaloneOverlay(target);

    destroy = standalone.destroy;

    standalone.service.open({
      kind: 'drawer',
      placement: 'bottom',
      title: 'Interface',
      showCloseButton: true,
      mount() {},
    });
    flushSync();

    expect(target.querySelector('.mndw-overlay-dialog__title')?.textContent).toBe('Interface');
    expect(target.querySelector<HTMLButtonElement>('.mndw-overlay-dialog__close')?.getAttribute('aria-label'))
      .toBe('Close');

    standalone.destroy();
    destroy = undefined;
    flushSync();
    await Promise.resolve();

    expect(target.querySelector('.mndw-overlay-dialog')).toBeNull();
  });
});
