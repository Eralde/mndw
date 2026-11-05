/** Parse a comma-separated capability field without changing token order or spelling. */
export function parseCapabilityList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
