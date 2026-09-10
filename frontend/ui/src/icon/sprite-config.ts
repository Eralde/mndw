let spriteUrl = '';

const listeners = new Set<() => void>();

export function getIconSpriteUrl(): string {
  return spriteUrl;
}

export function setIconSpriteUrl(url: string): void {
  if (url.includes('#')) {
    throw new Error(`iconSpriteUrl must not contain a fragment reference: "${url}"`);
  }

  if (url === spriteUrl) {
    return;
  }

  spriteUrl = url;

  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeIconSpriteUrl(callback: () => void): () => void {
  listeners.add(callback);

  return () => {
    listeners.delete(callback);
  };
}
