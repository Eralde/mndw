export const OPKG_COMPACT_BREAKPOINT_REM = 40;

export function observeCompactPanelWidth(
  element: HTMLElement,
  onChange: (compact: boolean) => void,
): () => void {
  if (typeof ResizeObserver === 'undefined') {
    onChange(false);

    return () => {};
  }

  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const breakpoint = OPKG_COMPACT_BREAKPOINT_REM * (rootFontSize > 0 ? rootFontSize : 16);
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === element) {
        onChange(entry.contentRect.width < breakpoint);
      }
    }
  });

  observer.observe(element);

  return () => observer.disconnect();
}
