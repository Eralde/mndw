import {describe, expect, it} from 'vitest';
import {highlightText} from './log-highlight';

describe('highlightText', () => {
  it('leaves empty queries unsegmented', () => {
    expect(highlightText('Router ready', '')).toEqual([{text: 'Router ready', match: false}]);
  });

  it('segments repeated case-insensitive matches while preserving source text', () => {
    expect(highlightText('Error error', 'error')).toEqual([
      {text: 'Error', match: true},
      {text: ' ', match: false},
      {text: 'error', match: true},
    ]);
  });

  it('keeps device text as segment data instead of HTML', () => {
    expect(highlightText('<script>alert(1)</script>', 'script')).toEqual([
      {text: '<', match: false},
      {text: 'script', match: true},
      {text: '>alert(1)</', match: false},
      {text: 'script', match: true},
      {text: '>', match: false},
    ]);
  });
});
