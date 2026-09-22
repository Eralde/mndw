import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, it} from 'vitest';

const globalCss = resolve(dirname(fileURLToPath(import.meta.url)), 'global.css');

it('keeps unitless scrollbar-size overrides while scaling fallback steps to rem', async () => {
  const source = await readFile(globalCss, 'utf8');

  expect(source).toContain('width: calc(var(--scrollbar-size, 10) * 0.0625rem);');
  expect(source).toContain('height: calc(var(--scrollbar-size, 10) * 0.0625rem);');
  expect(source).not.toContain('var(--scrollbar-size, 10) * 1px');
});

it('preserves tab-panel host padding after the universal reset', async () => {
  const source = await readFile(globalCss, 'utf8');

  expect(source).toMatch(/mndw-tab-panel\s*\{[\s\S]*padding:\s*var\(--mndw-space-3\);/u);
});

it('removes first-heading margin inside settings tab panels', async () => {
  const source = await readFile(globalCss, 'utf8');

  expect(source).toMatch(
    /\.mndw-settings mndw-tab-panel > :first-child > h3,[\s\S]*\.mndw-settings mndw-tab-panel > :first-child > :first-child > h3[\s\S]*margin-top:\s*0;/u,
  );
});

it('gives the tile close button a visible 44px target on touch and mobile layouts', async () => {
  const source = await readFile(globalCss, 'utf8');

  expect(source).toMatch(
    /@media \(pointer: coarse\) \{\s*\.mndw-grid-tile__close,\s*\.mndw-mobile-dashboard \.mndw-grid-tile__close \{[\s\S]*?width: 2\.75rem;[\s\S]*?height: 2\.75rem;[\s\S]*?opacity: 1;/u,
  );
  expect(source).toMatch(
    /\.mndw-mobile-dashboard \.mndw-grid-tile__close \{[\s\S]*?width: 2\.75rem;[\s\S]*?height: 2\.75rem;[\s\S]*?opacity: 1;/u,
  );
  expect(source).toMatch(/\.mndw-mobile-dashboard \.mndw-grid-tile__title \{[\s\S]*?padding-right: 3rem;/u);
  expect(source).toMatch(
    /@media \(pointer: coarse\) \{[\s\S]*?\.mndw-grid-tile__title \{[\s\S]*?padding-right: 3rem;/u,
  );
});
