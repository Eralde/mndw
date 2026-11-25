import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

// happy-dom cannot measure layout, so the rule that lines the two columns up is pinned in the stylesheets.
function rule(file: string, selector: string): string {
  const css = readFileSync(`src/${file}`, 'utf8').split('<style>')[1] ?? '';
  const start = css.indexOf(`${selector} {`);

  return start === -1 ? '' : css.slice(start, css.indexOf('}', start));
}

describe('column headers', () => {
  it('give both titles one height from one shared value, centered in it', () => {
    expect(rule('SmartPage.svelte', '.layout')).toContain('--smart-header-min-h: var(--mndw-control-h);');

    for (
      const [file, selector] of [['components/DeviceList.svelte', '.heading'], [
        'components/DeviceDetails.svelte',
        '.header',
      ]]
    ) {
      const header = rule(file, selector);

      expect(header).toContain('min-height: var(--smart-header-min-h);');
      expect(header).toContain('align-items: center;');
    }
  });

  it('space the blocks of both columns by the same gap', () => {
    for (
      const [file, selector] of [['components/DeviceList.svelte', '.device-list'], [
        'components/DeviceDetails.svelte',
        '.device-details',
      ], ['SmartPage.svelte', '.detail-column']]
    ) {
      expect(rule(file, selector)).toContain('gap: var(--mndw-space-4);');
    }
  });
});
