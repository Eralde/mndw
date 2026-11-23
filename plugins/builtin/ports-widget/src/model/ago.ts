import type {Translator} from '@mndw/sdk/svelte';

export type AgoUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export interface Ago {
  readonly unit: AgoUnit;
  readonly count: number;
}

/** Time since the link changed; `last-change` is already a duration in seconds, not a timestamp. */
export function timeAgo(lastChangeSeconds: number | null): Ago | null {
  if (lastChangeSeconds === null) {
    return null;
  }

  const elapsed = Math.floor(lastChangeSeconds);

  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return null;
  }

  if (elapsed < 60) {
    return {unit: 'seconds', count: elapsed};
  }

  if (elapsed < 3600) {
    return {unit: 'minutes', count: Math.floor(elapsed / 60)};
  }

  if (elapsed < 86400) {
    return {unit: 'hours', count: Math.floor(elapsed / 3600)};
  }

  return {unit: 'days', count: Math.floor(elapsed / 86400)};
}

export function formatAgo(ago: Ago, translator: Pick<Translator, 't'>): string {
  return translator.t(`ago.${ago.unit}`, {count: ago.count});
}
