interface IconSpriteStore {
  url: string;
  listeners: Set<() => void>;
}

const ICON_SPRITE_STORE_KEY = Symbol.for('mndw.ui.iconSprite');
const globalStore = globalThis as unknown as Record<symbol, unknown>;

function getStore(): IconSpriteStore {
  const existing = globalStore[ICON_SPRITE_STORE_KEY] as IconSpriteStore | undefined;

  if (existing !== undefined) {
    return existing;
  }

  const created: IconSpriteStore = {url: '', listeners: new Set()};

  globalStore[ICON_SPRITE_STORE_KEY] = created;

  return created;
}

export function getIconSpriteUrl(): string {
  return getStore().url;
}

export function setIconSpriteUrl(url: string): void {
  if (url.includes('#')) {
    throw new Error(`iconSpriteUrl must not contain a fragment reference: "${url}"`);
  }

  const store = getStore();

  if (url === store.url) {
    return;
  }

  store.url = url;

  for (const listener of [...store.listeners]) {
    listener();
  }
}

export function subscribeIconSpriteUrl(callback: () => void): () => void {
  const listeners = getStore().listeners;

  listeners.add(callback);

  return () => {
    listeners.delete(callback);
  };
}
