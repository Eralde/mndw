export function syncMndwTheme(doc: Document): () => void {
  const html = doc.documentElement;
  const sync = (): void => {
    html.dataset.theme = html.classList.contains('dark') ? 'dark' : 'light';
  };

  sync();

  const observer = new MutationObserver(sync);

  observer.observe(html, {attributes: true, attributeFilter: ['class']});

  return () => {
    observer.disconnect();
  };
}
