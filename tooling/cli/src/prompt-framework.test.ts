import {PassThrough} from 'node:stream';
import {describe, expect, it} from 'vitest';

import {promptFramework} from './prompt-framework.js';

describe('promptFramework', () => {
  it.each(
    [
      ['\n', 'svelte'],
      ['2\n', 'vue'],
      ['angular\n', 'angular'],
      ['x\nx\nx\n', 'svelte'],
    ] as const,
  )('maps scripted input %j to %s', async (script, expected) => {
    const input = new PassThrough();
    const output = new PassThrough();

    input.end(script);

    await expect(promptFramework({input, output})).resolves.toBe(expected);
  });
});
