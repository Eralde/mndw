// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {hostT} from '../../services/host-i18n.svelte.js';
import {toast} from '../../services/toast/toast.svelte.js';

const {downloadDiagnostics} = vi.hoisted(() => ({
  downloadDiagnostics: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../services/diagnostics.service.js', () => ({
  downloadDiagnostics: (): Promise<void> => downloadDiagnostics(),
}));

import DiagnosticsSettings from './DiagnosticsSettings.svelte';

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;

beforeAll(() => {
  defineMndwUi();
});

beforeEach(() => {
  downloadDiagnostics.mockReset().mockResolvedValue(undefined);
  toast.clear();
});

afterEach(async () => {
  if (component !== undefined) {
    await unmount(component);
    component = undefined;
  }

  toast.clear();
  document.body.innerHTML = '';
});

describe('DiagnosticsSettings download feedback', () => {
  it('shows a failed download as an error toast without a lasting alert', async () => {
    downloadDiagnostics.mockRejectedValueOnce(new Error('private failure detail'));
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(DiagnosticsSettings, {target});
    flushSync();

    target.querySelector('mndw-button')?.click();

    await vi.waitFor(() =>
      expect(toast.toasts[0]).toMatchObject({
        variant: 'error',
        message: hostT('settings.diagnostics-failed'),
      })
    );
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.textContent).not.toContain('private failure detail');
  });

  it('reuses the download error toast and dismisses it after a successful retry', async () => {
    const requests: Array<{resolve: () => void; reject: (error: Error) => void}> = [];

    downloadDiagnostics.mockImplementation(() => {
      return new Promise<void>((resolve, reject) => {
        requests.push({resolve, reject});
      });
    });
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(DiagnosticsSettings, {target});
    flushSync();

    const button = target.querySelector('mndw-button');

    button?.click();
    requests[0]?.reject(new Error('private failure detail'));
    await vi.waitFor(() => expect(toast.toasts).toHaveLength(1));

    button?.click();
    requests[1]?.reject(new Error('private failure detail'));
    await vi.waitFor(() => expect(target.textContent).toContain('Download diagnostics'));

    expect(toast.toasts).toHaveLength(1);
    expect(toast.toasts[0]?.key).toBe('settings.diagnostics.download');

    button?.click();
    requests[2]?.resolve();
    await vi.waitFor(() => expect(target.textContent).toContain('Download diagnostics'));

    expect(toast.toasts).toHaveLength(0);
  });
});

describe('DiagnosticsSettings lifetime', () => {
  it('does not show a toast when the download fails after unmount', async () => {
    let rejectRequest: ((error: Error) => void) | undefined;

    const request = new Promise<void>((_resolve, reject) => {
      rejectRequest = reject;
    });

    downloadDiagnostics.mockReturnValueOnce(request);
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(DiagnosticsSettings, {target});
    flushSync();

    target.querySelector('mndw-button')?.click();
    await vi.waitFor(() => expect(downloadDiagnostics).toHaveBeenCalledOnce());
    await unmount(component);
    component = undefined;

    rejectRequest?.(new Error('private failure detail'));
    await request.catch(() => {});

    expect(toast.toasts).toHaveLength(0);
  });
});
