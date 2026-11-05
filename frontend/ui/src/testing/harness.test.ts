// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MNDW_SWITCH_TAG, MndwSwitch} from '../switch/switch.js';
import {defineComponents, mount, press, settle} from './index.js';

const PROBE_TAG = 'mndw-harness-probe';

class HarnessProbe extends HTMLElement {}

class OtherHarnessProbe extends HTMLElement {}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ui test harness', () => {
  it('registers targeted components idempotently', () => {
    defineComponents([PROBE_TAG, HarnessProbe]);
    defineComponents([PROBE_TAG, HarnessProbe]);

    expect(customElements.get(PROBE_TAG)).toBe(HarnessProbe);
  });

  it('does not replace an existing registration', () => {
    defineComponents([PROBE_TAG, HarnessProbe]);
    defineComponents([PROBE_TAG, OtherHarnessProbe]);

    expect(customElements.get(PROBE_TAG)).toBe(HarnessProbe);
  });

  it('reports the requested tag when mounted markup does not contain it', async () => {
    await expect(mount('<p>not a switch</p>', MNDW_SWITCH_TAG)).rejects.toThrow(
      `missing ${MNDW_SWITCH_TAG}`,
    );
  });

  it('mounts the requested component with its mapped element type', async () => {
    defineComponents([MNDW_SWITCH_TAG, MndwSwitch]);

    const element: MndwSwitch = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);

    expect(element).toBeInstanceOf(MndwSwitch);
    expect(element.checked).toBe(false);
  });

  it('keeps mount and press macrotask-free while settle uses exactly one macrotask', async () => {
    defineComponents([MNDW_SWITCH_TAG, MndwSwitch]);

    const mountTimer = vi.spyOn(globalThis, 'setTimeout');
    const element = await mount('<mndw-switch></mndw-switch>', MNDW_SWITCH_TAG);

    expect(mountTimer).not.toHaveBeenCalled();
    mountTimer.mockRestore();

    const pressTimer = vi.spyOn(globalThis, 'setTimeout');

    await press(element, 'a');

    expect(pressTimer).not.toHaveBeenCalled();
    pressTimer.mockRestore();

    vi.useFakeTimers();

    try {
      let resolveUpdate: () => void = () => {};
      const updateComplete = new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      });
      const pendingElement = Object.assign(document.createElement('div'), {updateComplete});
      const settling = settle(pendingElement);

      expect(vi.getTimerCount()).toBe(1);
      await vi.runOnlyPendingTimersAsync();
      expect(vi.getTimerCount()).toBe(0);

      let completed = false;

      void settling.then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);

      resolveUpdate();
      await settling;
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles for exactly two turns when requested', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const element = Object.assign(document.createElement('div'), {updateComplete: Promise.resolve()});

    await settle(element, 2);

    expect(timer).toHaveBeenCalledTimes(2);
  });
});
