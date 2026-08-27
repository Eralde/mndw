import {configDefaults} from 'vitest/config';
import {describe, expect, it} from 'vitest';
import {defineMndwVitestProject} from './vitest-project.js';

describe('defineMndwVitestProject goldens', () => {
  it('plain happy-dom + setupFiles (e.g. clock-widget)', () => {
    expect(defineMndwVitestProject({environment: 'happy-dom', setupFiles: ['./vitest.setup.ts']})).toEqual({
      test: {environment: 'happy-dom', setupFiles: ['./vitest.setup.ts']},
    });
  });

  it('svelte plugin + resolve.conditions (e.g. system-log-page)', () => {
    const plugin = {name: 'stub-svelte'};

    expect(
      defineMndwVitestProject({
        environment: 'happy-dom',
        setupFiles: ['./vitest.setup.ts'],
        plugins: [plugin],
        resolve: {conditions: ['browser']},
      }),
    ).toEqual({
      plugins: [plugin],
      resolve: {conditions: ['browser']},
      test: {environment: 'happy-dom', setupFiles: ['./vitest.setup.ts']},
    });
  });

  it('node + css + vue plugin (e.g. clients-widget)', () => {
    const plugin = {name: 'stub-vue'};

    expect(
      defineMndwVitestProject({
        environment: 'node',
        css: true,
        plugins: [plugin],
        setupFiles: ['./vitest.setup.ts'],
      }),
    ).toEqual({
      plugins: [plugin],
      test: {environment: 'node', css: true, setupFiles: ['./vitest.setup.ts']},
    });
  });

  it('node + vue plugin without css (e.g. device-info-widget)', () => {
    const plugin = {name: 'stub-vue-no-css'};

    expect(
      defineMndwVitestProject({
        environment: 'node',
        plugins: [plugin],
        setupFiles: ['./vitest.setup.ts'],
      }),
    ).toEqual({
      plugins: [plugin],
      test: {environment: 'node', setupFiles: ['./vitest.setup.ts']},
    });
  });

  it('@mndw/ui shape (extraExclude, no setupFiles)', () => {
    expect(defineMndwVitestProject({environment: 'happy-dom', extraExclude: ['e2e/**']})).toEqual({
      test: {environment: 'happy-dom', exclude: [...configDefaults.exclude, 'e2e/**']},
    });
  });

  it('omits keys whose options were not provided', () => {
    expect(defineMndwVitestProject({environment: 'happy-dom'})).toEqual({test: {environment: 'happy-dom'}});
  });
});
