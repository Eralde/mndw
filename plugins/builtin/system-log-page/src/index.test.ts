// @vitest-environment happy-dom
import {flushSync} from 'svelte';
import {NEVER, Subject} from 'rxjs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import type {OverlayService, PluginContext, PluginRciManager} from '@mndw/sdk';
import type {RciBackgroundProcess} from '@rci-tools/core';
import enCatalog from '../i18n/en.json';
import {createInstance} from './index';

afterEach(() => vi.restoreAllMocks());

function context(): {
  pluginContext: PluginContext;
  queue: ReturnType<typeof vi.fn>;
  queueBackgroundProcess: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  const abort = vi.fn(() => true);
  const process = {
    data$: NEVER,
    done$: new Subject(),
    state$: new Subject(),
    abort,
  } as unknown as RciBackgroundProcess;
  const queue = vi.fn(() => NEVER);
  const queueBackgroundProcess = vi.fn(() => process);

  return {
    pluginContext: {
      rciManager: {queue, queueBackgroundProcess} as unknown as PluginRciManager,
      overlay: {} as OverlayService,
      i18n: createTestI18n(enCatalog),
    } as unknown as PluginContext,
    queue,
    queueBackgroundProcess,
    abort,
  };
}

describe('createInstance', () => {
  it('mounts into supplied container and exposes unmount', () => {
    const host = document.createElement('div');

    document.body.appendChild(host);

    const setup = context();
    const instance = createInstance(host, setup.pluginContext);

    flushSync();

    expect(host.querySelector('[data-system-log-page]')).not.toBeNull();
    expect(setup.queue).toHaveBeenCalledWith({
      path: 'show.log',
      data: {'once': true, 'max-lines': 500},
    });
    expect(setup.queueBackgroundProcess).toHaveBeenCalledWith({
      path: 'show.log',
      data: {'max-lines': 500},
    });
    instance.unmount();
    expect(setup.abort).toHaveBeenCalled();
    expect(host.querySelector('[data-system-log-page]')).toBeNull();
    host.remove();
  });
});
