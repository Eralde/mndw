// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import {useTranslator} from '@mndw/sdk/vue';
import {type App as VueApp, createApp, nextTick} from 'vue';
import CopyField from './CopyField.vue';

const FAILURE_MESSAGE = 'Copy failed — the text is selected, press Ctrl+C / ⌘C.';

let host: HTMLElement;
let app: VueApp | null = null;
let originalExecCommand: PropertyDescriptor | undefined;
let execCommandStubbed = false;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (execCommandStubbed) {
    if (originalExecCommand === undefined) {
      delete (document as unknown as {execCommand?: unknown}).execCommand;
    } else {
      Object.defineProperty(document, 'execCommand', originalExecCommand);
    }

    execCommandStubbed = false;
    originalExecCommand = undefined;
  }

  delete (window as unknown as Record<string, unknown>).isSecureContext;
});

function setSecureContext(isSecureContext: boolean): void {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: isSecureContext,
  });
}

function stubExecCommand(implementation: () => boolean): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn(implementation);

  originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
  execCommandStubbed = true;

  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: execCommand,
  });

  return execCommand;
}

function mountCopyField(): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(CopyField, {
    label: 'Serial',
    value: 'SN-123',
    translator: useTranslator(createTestI18n({
      'copy': 'Copy',
      'copied': 'Copied!',
      'copy-failed': FAILURE_MESSAGE,
    })),
  });
  app.mount(host);

  expect(host.querySelector('button')).toBeNull();

  const copyButton = host.querySelector<HTMLElement>('mndw-button');

  if (copyButton === null) {
    throw new Error('copy button was not rendered');
  }

  return copyButton;
}

async function clickCopy(copyButton: HTMLElement): Promise<void> {
  copyButton.click();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await nextTick();
}

describe('CopyField', () => {
  it('uses the shared button and copies with the secure clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    setSecureContext(true);
    vi.stubGlobal('navigator', {clipboard: {writeText}});

    const copyButton = mountCopyField();

    await clickCopy(copyButton);

    expect(writeText).toHaveBeenCalledWith('SN-123');
    expect(copyButton.textContent).toContain('Copied!');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Copied!');
  });

  it('falls back to execCommand when the clipboard API is unavailable', async () => {
    const execCommand = stubExecCommand(() => true);

    setSecureContext(false);
    vi.stubGlobal('navigator', {});

    const copyButton = mountCopyField();

    await clickCopy(copyButton);

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copyButton.textContent).toContain('Copied!');
    expect(host.textContent).not.toContain(FAILURE_MESSAGE);
  });

  it('does not use the clipboard API on an insecure origin', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = stubExecCommand(() => true);

    setSecureContext(false);
    vi.stubGlobal('navigator', {clipboard: {writeText}});

    const copyButton = mountCopyField();

    await clickCopy(copyButton);

    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copyButton.textContent).toContain('Copied!');
  });

  it('selects the value and shows a failure message when execCommand returns false', async () => {
    const execCommand = stubExecCommand(() => false);

    setSecureContext(false);
    vi.stubGlobal('navigator', {});

    const copyButton = mountCopyField();

    await clickCopy(copyButton);

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copyButton.textContent).not.toContain('Copied!');
    expect(host.textContent).toContain(FAILURE_MESSAGE);
    expect(window.getSelection()?.toString()).toBe('SN-123');
  });

  it('shows a failure message when execCommand throws', async () => {
    const execCommand = stubExecCommand(() => {
      throw new Error('copy blocked');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    setSecureContext(false);
    vi.stubGlobal('navigator', {});

    const copyButton = mountCopyField();

    await clickCopy(copyButton);

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(consoleError).toHaveBeenCalled();
    expect(host.textContent).toContain(FAILURE_MESSAGE);
    expect(window.getSelection()?.toString()).toBe('SN-123');
  });

  it('falls back to execCommand when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    const execCommand = stubExecCommand(() => true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    setSecureContext(true);
    vi.stubGlobal('navigator', {clipboard: {writeText}});

    const copyButton = mountCopyField();

    await clickCopy(copyButton);

    expect(writeText).toHaveBeenCalledWith('SN-123');
    expect(consoleError).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copyButton.textContent).toContain('Copied!');
  });
});
