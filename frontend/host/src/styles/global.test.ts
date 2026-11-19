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

it('paints the new tile highlight above content while keeping the close button above it', async () => {
  const source = await readFile(globalCss, 'utf8');
  const highlightRule = source.match(/\.mndw-grid-tile--newly-added::after\s*\{([^}]*)\}/u)?.[1] ?? '';
  const reducedMotionRule =
    source.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mndw-grid-tile--newly-added::after\s*\{([^}]*)\}/u)
      ?.[1]
      ?? '';

  expect(source).toMatch(/\.mndw-grid-tile\s*\{[^}]*position: relative;/u);
  expect(highlightRule).toContain('content: \'\';');
  expect(highlightRule).toContain('position: absolute;');
  expect(highlightRule).toContain('inset: 0;');
  expect(highlightRule).toContain('z-index: 1;');
  expect(highlightRule).toContain('pointer-events: none;');
  expect(highlightRule).toContain('border-radius: inherit;');
  expect(highlightRule).toContain('animation: mndw-newly-added-highlight 1.6s ease-out;');
  expect(reducedMotionRule).toContain('box-shadow: inset 0 0 0 2px var(--mndw-accent);');
  expect(reducedMotionRule).toContain('animation: none;');
  expect(source).toMatch(
    /\.mndw-grid-tile__close\s*\{[^}]*position: absolute;[^}]*top: 0\.25rem;[^}]*right: 0\.25rem;[^}]*z-index: 2;/u,
  );
});
