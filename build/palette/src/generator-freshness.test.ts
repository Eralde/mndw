import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {renderCss, renderTs} from '../scripts/gen-tokens.js';
import {TOKENS_REQUIRED} from '../../../frontend/ui/src/tokens-required.js';

const committedCss = new URL('../../../frontend/sdk/src/tokens.css', import.meta.url);
const committedTs = new URL('../../../frontend/sdk/src/tokens.ts', import.meta.url);

describe('generated token freshness', () => {
  it('matches generator output byte-for-byte', async () => {
    expect(await readFile(committedCss, 'utf8')).toBe(renderCss());
    expect(await readFile(committedTs, 'utf8')).toBe(renderTs());
  });

  it('emits every UI-required token', async () => {
    const css = await readFile(committedCss, 'utf8');

    for (const token of TOKENS_REQUIRED) {
      expect(css, token).toContain(`${token}:`);
    }
  });
});
