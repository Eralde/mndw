const LOG_PREFIX = '[device-info-widget]';

/**
 * Whether the async Clipboard API is usable on the current origin.
 * The API is only exposed in secure contexts, so plain-HTTP plugin pages
 * must fall back to `document.execCommand('copy')`.
 */
export function canUseClipboardApi(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext === true
    && typeof navigator !== 'undefined'
    && typeof navigator.clipboard?.writeText === 'function';
}

function restoreFocusAndSelection(
  previousActiveElement: Element | null,
  selection: Selection | null,
  previousRanges: readonly Range[],
): void {
  if (previousActiveElement instanceof HTMLElement && previousActiveElement.isConnected) {
    try {
      previousActiveElement.focus({preventScroll: true});
    } catch (ex) {
      console.error(`${LOG_PREFIX} restoring focus after copy failed`, ex);
    }
  }

  if (selection === null) {
    return;
  }

  try {
    selection.removeAllRanges();

    for (const range of previousRanges) {
      selection.addRange(range);
    }
  } catch (ex) {
    console.error(`${LOG_PREFIX} restoring selection after copy failed`, ex);
  }
}

/**
 * Copies text through a temporary off-screen textarea using the legacy
 * `document.execCommand('copy')` path. Returns whether the copy succeeded.
 */
export function copyUsingExecCommand(value: string): boolean {
  if (typeof document === 'undefined' || document.body === null) {
    return false;
  }

  if (typeof document.execCommand !== 'function') {
    return false;
  }

  const previousActiveElement = document.activeElement;
  const selection = document.getSelection();
  const previousRanges: Range[] = [];

  if (selection !== null) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      previousRanges.push(selection.getRangeAt(index));
    }
  }

  const textarea = document.createElement('textarea');

  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.setAttribute('tabindex', '-1');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.append(textarea);

  let copied = false;

  try {
    textarea.focus({preventScroll: true});
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    copied = document.execCommand('copy');
  } catch (ex) {
    console.error(`${LOG_PREFIX} document.execCommand('copy') failed`, ex);
  } finally {
    textarea.remove();
    restoreFocusAndSelection(previousActiveElement, selection, previousRanges);
  }

  return copied;
}

/**
 * Copies text, preferring the async Clipboard API and falling back to
 * `document.execCommand('copy')` on insecure origins or when the API rejects.
 * All sync and async failures are caught; details are logged to the console.
 */
export async function copyText(value: string): Promise<boolean> {
  if (canUseClipboardApi()) {
    try {
      await navigator.clipboard.writeText(value);

      return true;
    } catch (ex) {
      console.error(`${LOG_PREFIX} navigator.clipboard.writeText failed, trying execCommand`, ex);
    }
  }

  try {
    return copyUsingExecCommand(value);
  } catch (ex) {
    console.error(`${LOG_PREFIX} copy fallback failed`, ex);

    return false;
  }
}
