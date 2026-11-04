import {createInterface} from 'node:readline/promises';

import {type PluginFramework} from './framework.js';

const FRAMEWORKS: readonly PluginFramework[] = ['svelte', 'vue', 'angular', 'vanilla'];
const MENU = 'Choose a framework: 1) svelte (default)  2) vue  3) angular  4) vanilla';

/** Prompts at most three times and defaults to Svelte for Enter or invalid input. */
export async function promptFramework(io: {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}): Promise<PluginFramework> {
  const readline = createInterface({input: io.input, output: io.output});
  const lines = readline[Symbol.asyncIterator]();

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      io.output.write(`${MENU}\n`);

      const line = await lines.next();

      if (line.done) {
        return 'svelte';
      }

      const answer = line.value.trim().toLowerCase();

      if (answer === '') {
        return 'svelte';
      }

      const numeric = Number.parseInt(answer, 10);
      const selected = Number.isInteger(numeric) && String(numeric) === answer
        ? FRAMEWORKS[numeric - 1]
        : undefined;

      if (selected !== undefined) {
        return selected;
      }

      if (FRAMEWORKS.includes(answer as PluginFramework)) {
        return answer as PluginFramework;
      }
    }

    return 'svelte';
  } finally {
    readline.close();
  }
}
