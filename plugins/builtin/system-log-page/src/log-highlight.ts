export interface HighlightSegment {
  readonly text: string;
  readonly match: boolean;
}

export function highlightText(text: string, query: string): HighlightSegment[] {
  const normalizedQuery = query.toLowerCase();

  if (normalizedQuery.length === 0) {
    return [{text, match: false}];
  }

  const normalizedText = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, cursor);

    if (matchIndex < 0) {
      if (cursor < text.length) {
        segments.push({text: text.slice(cursor), match: false});
      }

      break;
    }

    if (matchIndex > cursor) {
      segments.push({text: text.slice(cursor, matchIndex), match: false});
    }

    segments.push({text: text.slice(matchIndex, matchIndex + query.length), match: true});
    cursor = matchIndex + query.length;
  }

  return segments;
}
