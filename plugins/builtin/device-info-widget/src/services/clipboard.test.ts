// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {canUseClipboardApi, copyText, copyUsingExecCommand} from './clipboard';

let originalExecCommand: PropertyDescriptor | undefined;
let execCommandStubbed = false;

afterEach(() => {
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
  document.body.replaceChildren();
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

describe('clipboard', () => {
  describe('canUseClipboardApi', () => {
    it('requires both a secure context and the async clipboard API', () => {
      const writeText = vi.fn();

      setSecureContext(true);
      vi.stubGlobal('navigator', {clipboard: {writeText}});
      expect(canUseClipboardApi()).toBe(true);

      setSecureContext(false);
      expect(canUseClipboardApi()).toBe(false);

      setSecureContext(true);
      vi.stubGlobal('navigator', {clipboard: undefined});
      expect(canUseClipboardApi()).toBe(false);
    });
  });

  describe('copyText', () => {
    it('uses the async clipboard API in a secure context', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);

      setSecureContext(true);
      vi.stubGlobal('navigator', {clipboard: {writeText}});

      await expect(copyText('SN-123')).resolves.toBe(true);

      expect(writeText).toHaveBeenCalledWith('SN-123');
    });

    it('falls back to execCommand when writeText rejects', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
      const execCommand = stubExecCommand(() => true);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      setSecureContext(true);
      vi.stubGlobal('navigator', {clipboard: {writeText}});

      await expect(copyText('SN-123')).resolves.toBe(true);

      expect(writeText).toHaveBeenCalledWith('SN-123');
      expect(consoleError).toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith('copy');
    });

    it('returns false when both copy paths fail', async () => {
      stubExecCommand(() => false);

      setSecureContext(false);
      vi.stubGlobal('navigator', {});

      await expect(copyText('SN-123')).resolves.toBe(false);
    });
  });

  describe('copyUsingExecCommand', () => {
    it('copies through a temporary readonly textarea and restores focus and selection', () => {
      expect.assertions(10);

      const input = document.createElement('input');
      const paragraph = document.createElement('p');

      paragraph.textContent = 'existing selection';
      document.body.append(input, paragraph);

      const previousSelection = document.getSelection();

      if (previousSelection === null) {
        throw new Error('selection API unavailable');
      }

      const previousRange = document.createRange();

      previousRange.selectNodeContents(paragraph);
      previousSelection.addRange(previousRange);
      input.focus();

      const execCommand = stubExecCommand(() => {
        const textarea = document.querySelector('textarea');
        const activeElement = document.activeElement;

        expect(textarea).not.toBeNull();
        expect(textarea?.readOnly).toBe(true);
        expect(textarea?.value).toBe('SN-123');
        expect(activeElement).toBe(textarea);
        expect(document.querySelector('textarea')).not.toBeNull();

        return true;
      });

      expect(copyUsingExecCommand('SN-123')).toBe(true);
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(document.querySelector('textarea')).toBeNull();
      expect(document.activeElement).toBe(input);
      expect(document.getSelection()?.toString()).toBe('existing selection');
    });

    it('returns false when execCommand reports failure', () => {
      stubExecCommand(() => false);

      expect(copyUsingExecCommand('SN-123')).toBe(false);
      expect(document.querySelector('textarea')).toBeNull();
    });

    it('returns false when execCommand throws', () => {
      stubExecCommand(() => {
        throw new Error('copy blocked');
      });

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(copyUsingExecCommand('SN-123')).toBe(false);
      expect(consoleError).toHaveBeenCalled();
      expect(document.querySelector('textarea')).toBeNull();
    });

    it('returns false when execCommand is not available', () => {
      expect(copyUsingExecCommand('SN-123')).toBe(false);
    });
  });
});
