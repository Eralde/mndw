const ACCENTS: Record<string, string> = {
  A: 'Ȧ',
  B: 'Ḃ',
  C: 'Ç',
  D: 'Ḋ',
  E: 'Ḗ',
  F: 'Ḟ',
  G: 'Ġ',
  H: 'Ḧ',
  I: 'Ī',
  J: 'Ĵ',
  K: 'Ḱ',
  L: 'Ŀ',
  M: 'Ṁ',
  N: 'Ṅ',
  O: 'Ö',
  P: 'Ṕ',
  Q: 'Q',
  R: 'Ŕ',
  S: 'Ṡ',
  T: 'Ṫ',
  U: 'Ū',
  V: 'Ṽ',
  W: 'Ẇ',
  X: 'Ẋ',
  Y: 'Ẏ',
  Z: 'Ż',
  a: 'ȧ',
  b: 'ḃ',
  c: 'ç',
  d: 'ḋ',
  e: 'ḗ',
  f: 'ḟ',
  g: 'ġ',
  h: 'ḧ',
  i: 'ī',
  j: 'ĵ',
  k: 'ḱ',
  l: 'ŀ',
  m: 'ṁ',
  n: 'ṅ',
  o: 'ö',
  p: 'ṕ',
  q: 'q',
  r: 'ŕ',
  s: 'ṡ',
  t: 'ṫ',
  u: 'ū',
  v: 'ṽ',
  w: 'ẇ',
  x: 'ẋ',
  y: 'ẏ',
  z: 'ż',
};

export type CatalogNode = string | CatalogRecord;
// Recursive catalog shape cannot use Record alias without triggering circular type expansion in Angular.
export interface CatalogRecord {
  [key: string]: CatalogNode;
}

function accent(value: string): string {
  return [...value].map((character) => ACCENTS[character] ?? character).join('');
}

/** Deterministic dev-only pseudo localization: accents, expansion, and visible brackets. */
export function pseudoLocalize(value: string): string {
  const expanded = value.replace(/\b\w+\b/g, (word) => {
    const padding = '~'.repeat(Math.max(1, Math.ceil(word.length * 0.35)));

    return `${word}${padding}`;
  });

  return `[${accent(expanded)}]`;
}

export function pseudoLocalizeCatalog(catalog: Record<string, CatalogNode>): Record<string, CatalogNode> {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, value]) => [
      key,
      typeof value === 'string' ? pseudoLocalize(value) : pseudoLocalizeCatalog(value),
    ]),
  );
}
