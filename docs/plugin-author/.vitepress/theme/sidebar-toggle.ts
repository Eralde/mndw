export const SIDEBAR_TOGGLE_EVENT = 'mndw:toggle-sidebar';

export function toggleSidebar(doc: Document): void {
  const sidebar = doc.querySelector<HTMLElement>('.VPSidebar');

  if (sidebar?.classList.contains('open')) {
    doc.querySelector<HTMLElement>('.VPBackdrop')?.click();

    return;
  }

  doc.querySelector<HTMLElement>('.VPLocalNav .menu')?.click();
}

export function observeSidebarOpen(doc: Document, onChange: (open: boolean) => void): () => void {
  const sidebar = doc.querySelector<HTMLElement>('.VPSidebar');

  if (sidebar === null) {
    onChange(false);

    return () => {};
  }

  const report = (): void => {
    onChange(sidebar.classList.contains('open'));
  };
  const observer = new MutationObserver(report);

  observer.observe(sidebar, {attributes: true, attributeFilter: ['class']});
  report();

  return () => observer.disconnect();
}
