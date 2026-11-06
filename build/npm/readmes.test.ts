import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {UI_CATALOG} from '../../docs/plugin-author/.vitepress/ui-catalog.js';
import {PUBLISHED_PACKAGES} from './pack-all.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const site = 'https://eralde.github.io/mndw/';
const read = (path: string): string => {
  return readFileSync(resolve(root, path), 'utf8');
};

describe('published package READMEs', () => {
  for (const {relativeDir: directory} of PUBLISHED_PACKAGES) {
    it(`${directory} introduces the package and matches its description`, () => {
      const metadata = JSON.parse(read(`${directory}/package.json`)) as {name: string; description?: string};
      expect(existsSync(resolve(root, `${directory}/README.md`))).toBe(true);
      const source = read(`${directory}/README.md`);
      expect(source.split('\n')[0]).toBe(`# ${metadata.name}`);
      expect(source).toContain(site);
      expect(source).toContain('Everything in it is a plugin: a dashboard widget or a full page.');
      expect(metadata.description?.trim()).toBeTruthy();
      expect(source.match(/^# [^\n]+\n\n([^\n]+)/)?.[1]).toBe(metadata.description);
    });
  }

  it('uses code spans for custom-element link text in every README', () => {
    for (
      const path of [
        'README.md',
        ...PUBLISHED_PACKAGES.map(({relativeDir}) => {
          return `${relativeDir}/README.md`;
        }),
      ]
    ) {
      expect(read(path), path).not.toMatch(/\[<[a-z]/);
    }
  });

  it('lists the UI catalog in order without extra component links', () => {
    const source = read('frontend/ui/README.md');
    const slugs = [...source.matchAll(/^\| \[[^\]]+\]\(https:\/\/eralde\.github\.io\/mndw\/ui\/([a-z-]+)\) \|/gm)].map(
      (match) => {
        return match[1];
      },
    );
    expect(slugs).toEqual(UI_CATALOG.map((entry) => {
      return entry.slug;
    }));
  });

  it('uses existing site pages and explicit dev directories', () => {
    const config = JSON.parse(read('build/docs/typedoc.json')) as {entryPoints: string[]};
    const generated = new Set([
      'api/',
      ...config.entryPoints.map((entry) => {
        const source = readFileSync(resolve(root, 'build/docs', entry), 'utf8');
        const moduleName = source.match(/@module\s+@mndw\/([^\s*]+)/)?.[1];
        expect(moduleName, entry).toBeTruthy();
        return `api/${moduleName}`;
      }),
    ]);
    for (
      const path of [
        'README.md',
        ...PUBLISHED_PACKAGES.map(({relativeDir}) => {
          return `${relativeDir}/README.md`;
        }),
      ]
    ) {
      const source = read(path);
      for (const match of source.matchAll(/https:\/\/eralde\.github\.io\/mndw\/([^\s)<>]*?)(?=[\s)<>]|$)/g)) {
        const target = (match[1] ?? '').split(/[?#]/)[0].replace(/\/$/, '');
        expect(
          target === '' || generated.has(target) || generated.has(`${target}/`)
            || existsSync(resolve(root, `docs/plugin-author/${target}.md`))
            || existsSync(resolve(root, `docs/plugin-author/${target}/index.md`)),
          `${path}: ${match[0]}`,
        ).toBe(true);
      }
      expect(source, path).not.toMatch(/\bmndw dev\s+--addr\b|\bmndw dev\s*(?:`|$)/m);
    }
  });
});
