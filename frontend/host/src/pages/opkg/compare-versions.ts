const SEGMENT_SEPARATORS = /[.\-+]/;

const isDigits = (value: string): boolean => value.length > 0 && /^[0-9]+$/.test(value);

export function compareVersions(a: string, b: string): number {
  const as = a.split(SEGMENT_SEPARATORS);
  const bs = b.split(SEGMENT_SEPARATORS);
  const length = Math.min(as.length, bs.length);

  for (let index = 0; index < length; index += 1) {
    const left = as[index];
    const right = bs[index];

    if (left === right) {
      continue;
    }

    if (isDigits(left) && isDigits(right)) {
      const diff = Number(left) - Number(right);

      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
    } else {
      const comparison = left.localeCompare(right);

      if (comparison !== 0) {
        return comparison < 0 ? -1 : 1;
      }
    }
  }

  return as.length - bs.length;
}
