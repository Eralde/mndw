import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {UI_CATALOG} from '../../docs/plugin-author/.vitepress/ui-catalog.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return entry.isFile() && /\.(?:mts|ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('UI component catalog', () => {
  it('covers every registered custom element exactly once', () => {
    const registeredTags = new Set<string>();

    for (const path of sourceFiles(resolve(repoRoot, 'frontend/ui/src'))) {
      const source = readFileSync(path, 'utf8');

      for (const match of source.matchAll(/export const MNDW_\w+_TAG\s*=\s*['"](mndw-[^'"]+)['"]/g)) {
        registeredTags.add(match[1]);
      }
    }

    const documentedTags = UI_CATALOG.flatMap((entry) => entry.tags);

    for (const tag of registeredTags) {
      expect(documentedTags.filter((candidate) => candidate === tag), tag).toHaveLength(1);
    }

    for (const tag of documentedTags) {
      expect(registeredTags.has(tag), tag).toBe(true);
    }
  });

  it('has an overview and a page for every entry', () => {
    expect(existsSync(resolve(repoRoot, 'docs/plugin-author/ui/index.md'))).toBe(true);

    for (const entry of UI_CATALOG) {
      expect(existsSync(resolve(repoRoot, `docs/plugin-author/ui/${entry.slug}.md`)), entry.slug).toBe(true);
    }
  });

  it('shows a demo for every page and names its documented tags', () => {
    for (const entry of UI_CATALOG) {
      const page = readFileSync(resolve(repoRoot, `docs/plugin-author/ui/${entry.slug}.md`), 'utf8');

      expect(page, entry.slug).toMatch(/```html demo|<UiScriptDemo/);

      for (const tag of entry.tags) {
        if (tag !== 'mndw-select-panel') {
          expect(page, `${entry.slug} should contain an opening ${tag} element`)
            .toMatch(new RegExp(`<${escapeRegExp(tag)}(?:\\s|>)`, 'u'));
        }
      }
    }
  });
});

describe('UI component sidebar catalog', () => {
  it('lists the overview and catalog entries in sidebar order', () => {
    const config = readFileSync(resolve(repoRoot, 'docs/plugin-author/.vitepress/config.mts'), 'utf8');
    const groupStart = config.indexOf('text: \'UI components\'');
    const referenceStart = config.indexOf('text: \'Reference\'', groupStart);
    const group = config.slice(groupStart, referenceStart);

    expect(groupStart).toBeGreaterThanOrEqual(0);
    expect(referenceStart).toBeGreaterThan(groupStart);
    expect(group).toContain('{text: \'Overview\', link: \'/ui/\'}');
    expect(group).toContain('...UI_CATALOG.map((entry) => ({text: entry.sidebarTitle, link: `/ui/${entry.slug}`}))');
    expect(UI_CATALOG.map((entry) => entry.slug)).toEqual([
      'button',
      'icon',
      'checkbox',
      'switch',
      'input',
      'textarea',
      'field',
      'select',
      'segmented',
      'slider',
      'tabs',
      'tooltip',
      'scroll-area',
      'table',
      'line-chart',
      'bar-chart',
      'sparkline',
      'heat-strip',
      'css-classes',
    ]);
  });

  it('uses escaped text for UI page titles rendered through VitePress v-html', () => {
    const button = UI_CATALOG.find((entry) => entry.slug === 'button');

    expect(button?.title).toBe('<mndw-button>');
    expect(button?.sidebarTitle).toBe('&lt;mndw-button&gt;');
  });
});

describe('UI playground theme and host boundary', () => {
  it('registers the HTML demo renderer with the VitePress app', () => {
    const theme = readFileSync(resolve(repoRoot, 'docs/plugin-author/.vitepress/theme/index.ts'), 'utf8');

    expect(theme).toContain('import UiHtmlDemo from \'./components/UiHtmlDemo.vue\';');
    expect(theme).toContain('app.component(\'UiHtmlDemo\', UiHtmlDemo);');
  });

  it('sets the theme before first paint', () => {
    const config = readFileSync(resolve(repoRoot, 'docs/plugin-author/.vitepress/config.mts'), 'utf8');

    expect(config).toMatch(/head:\s*\[[\s\S]*?document\.documentElement\.dataset\.theme/u);
  });

  it('imports host code through the standalone overlay seam only', () => {
    const docsTheme = resolve(repoRoot, 'docs/plugin-author/.vitepress');
    const seam = '../../../../frontend/host/src/services/overlay/standalone-overlay';

    for (const path of sourceFiles(docsTheme)) {
      const source = readFileSync(path, 'utf8');
      const imports = Array.from(source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]*frontend\/host[^'"]*)['"]/g));

      for (const match of imports) {
        expect(match[1], path).toBe(seam);
      }
    }
  });
});

function reference(slug: string): string {
  const page = readFileSync(resolve(repoRoot, `docs/plugin-author/ui/${slug}.md`), 'utf8');
  const start = page.indexOf('## Reference');

  return start < 0 ? '' : page.slice(start);
}

function expectReferenceContains(slug: string, hooks: readonly string[]): void {
  const text = reference(slug);

  for (const hook of hooks) {
    expect(text).toContain(hook);
  }
}

describe('UI component reference coverage', () => {
  it('documents checkbox state, form behavior, events, and parts', () => {
    expect(reference('checkbox')).toMatch(/checked|indeterminate/u);
    expect(reference('checkbox')).toContain('required');
    expect(reference('checkbox')).toContain('mndwchange');
    expect(reference('checkbox')).toMatch(/box.*mark.*label/su);
  });

  it('documents select portal styling and scroll-area hooks', () => {
    expect(reference('select')).toMatch(/panel-class` supplies a class name/u);
    expect(reference('select')).toContain('global CSS selector');

    const scrollArea = reference('scroll-area');

    for (
      const hook of [
        'viewport',
        'scrollbar',
        'track',
        'thumb',
        'refresh()',
        'viewportElement',
        '--mndw-scrollbar-size',
        '--mndw-scrollbar-thumb-hover',
        '--mndw-scrollbar-thumb-min-size',
      ]
    ) {
      expect(scrollArea).toContain(hook);
    }
  });

  it('documents table state, event, rendering, and virtualization APIs', () => {
    expectReferenceContains('table', [
      'mndwselectionchange',
      'mndwrowreorder',
      'expandable',
      'sticky',
      'virtual',
      'column-menu-panel-class',
      'scrollToRow()',
      'viewport',
      'error',
      'data-mndw-layout-inactive="virtual"',
      'data-mndw-sticky-inactive',
      'RTL',
      'CellRenderer',
      '@mndw/ui-svelte',
      'mndw-table-controls',
    ]);
  });
});

describe('UI component advanced reference coverage', () => {
  it('documents tooltip trigger warnings and keeps closed descriptions available', () => {
    const tooltip = reference('tooltip');

    expect(tooltip).toContain('warned about once');
    expect(tooltip).toContain('closed bubble is invisible');
    expect(tooltip).toContain('display: none');
    expect(tooltip).toContain('consumer rewrites that attribute');
  });

  it('documents compact chart time-axis rules and chart accessibility', () => {
    const sparkline = reference('sparkline');

    expect(sparkline).toContain('only when every normalized sample has a finite time');
    expect(sparkline).toContain('mixed timed and untimed samples');
    expect(sparkline).toContain('timeDomain');
    expect(sparkline).toContain('role="img"');
    expect(reference('line-chart')).toContain('valueFormatter');
    expect(reference('bar-chart')).toContain('positional band slots');
    expect(reference('heat-strip')).toContain('utilization scale');
  });
});

describe('UI component example markup', () => {
  it('keeps the control and tooltip examples within their supported markup', () => {
    const select = readFileSync(resolve(repoRoot, 'docs/plugin-author/ui/select.md'), 'utf8');
    const textarea = readFileSync(resolve(repoRoot, 'docs/plugin-author/ui/textarea.md'), 'utf8');
    const tooltip = readFileSync(resolve(repoRoot, 'docs/plugin-author/ui/tooltip.md'), 'utf8');
    const cssClasses = readFileSync(resolve(repoRoot, 'docs/plugin-author/ui/css-classes.md'), 'utf8');

    expect(select).toContain(
      '<mndw-option value="lan"><mndw-icon name="settings"></mndw-icon> LAN <span>1 Gbps</span>',
    );
    expect(select).not.toContain('slot="suffix"');
    expect(textarea).toContain('<mndw-textarea rows="3" disabled value="Read only"></mndw-textarea>');
    expect(tooltip).toContain('<mndw-button variant="ghost" aria-label="Refresh status">');
    expect(cssClasses).toContain('<mndw-input id="network-name" value="Home"');
    expect(cssClasses).not.toContain('<input id="network-name"');
  });
});
