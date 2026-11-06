import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {TOKENS_REQUIRED} from '../tokens-required.js';

const TOKEN_REFERENCE = /var\(\s*(--mndw-[a-z0-9-]+)([^)]*)\)/g;

const contracts = [
  {
    selector: '.mndw-alert',
    markup: 'alert with title/body and --danger|--success|--warning|--info modifiers; consumer-owned role and [hidden]',
  },
  {
    selector: '.mndw-alert__title',
    markup: 'alert title child',
  },
  {
    selector: '.mndw-alert__body',
    markup: 'alert body child',
  },
  {
    selector: '.mndw-alert--danger',
    markup: 'danger alert modifier',
  },
  {
    selector: '.mndw-alert--success',
    markup: 'success alert modifier',
  },
  {
    selector: '.mndw-alert--warning',
    markup: 'warning alert modifier',
  },
  {
    selector: '.mndw-alert--info',
    markup: 'info alert modifier',
  },
  {
    selector: '.mndw-badge',
    markup: 'inline status badge with --danger|--success|--warning|--info modifiers; no injected role',
  },
  {
    selector: '.mndw-badge--danger',
    markup: 'danger badge modifier',
  },
  {
    selector: '.mndw-badge--success',
    markup: 'success badge modifier',
  },
  {
    selector: '.mndw-badge--warning',
    markup: 'warning badge modifier',
  },
  {
    selector: '.mndw-badge--info',
    markup: 'info badge modifier',
  },
  {
    selector: '.mndw-status-dot',
    markup: 'decorative status dot with aria-hidden and --danger|--success|--warning|--info modifiers',
  },
  {
    selector: '.mndw-status-dot--danger',
    markup: 'danger status-dot modifier',
  },
  {
    selector: '.mndw-status-dot--success',
    markup: 'success status-dot modifier',
  },
  {
    selector: '.mndw-status-dot--warning',
    markup: 'warning status-dot modifier',
  },
  {
    selector: '.mndw-status-dot--info',
    markup: 'info status-dot modifier',
  },
  {
    selector: '.mndw-spinner',
    markup: 'decorative spinner with aria-hidden; consumer-owned busy semantics',
  },
  {
    selector: '.mndw-empty',
    markup: 'empty-state container with consumer-owned heading/status semantics',
  },
  {
    selector: '.mndw-progress',
    markup: 'indeterminate progress container with consumer-owned progressbar/aria-busy semantics',
  },
  {
    selector: '.mndw-field',
    markup: 'field containing first non-owned control plus label/hint/error children',
  },
  {
    selector: '.mndw-field__label',
    markup: 'field label child',
  },
  {
    selector: '.mndw-field__hint',
    markup: 'field hint child',
  },
  {
    selector: '.mndw-field__error',
    markup: 'field error child with role=alert and control aria wiring',
  },
  {
    selector: '.mndw-card',
    markup: 'semantic article/section/div card container with no injected role',
  },
  {
    selector: '.mndw-toolbar',
    markup: 'semantic toolbar container with consumer-owned role/name',
  },
  {
    selector: '.mndw-table',
    markup: 'table with caption, thead, tbody, tr, th, and td children',
  },
  {
    selector: '.mndw-table--sticky-head',
    markup: 'opt-in sticky header modifier using --mndw-table-sticky-top',
  },
  {
    selector: '.mndw-table thead',
    markup: 'semantic table header styling',
  },
  {
    selector: '.mndw-table th',
    markup: 'semantic table header-cell styling',
  },
  {
    selector: '.mndw-table td',
    markup: 'semantic table data-cell styling',
  },
  {
    selector: '.mndw-table tr',
    markup: 'semantic table row styling',
  },
  {
    selector: '[aria-sort]',
    markup: 'consumer-owned runtime sort state styling',
  },
  {
    selector: '[hidden]',
    markup: 'native runtime visibility state; no state class',
  },
] as const;

describe('kit.css class contract', () => {
  it.each(contracts)('$selector — $markup', async ({selector}) => {
    const css = await readFile(resolve(process.cwd(), 'src/styles/kit.css'), 'utf8');

    expect(css).toContain(selector);
  });

  it('resets toolbar heading margins', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/styles/kit.css'), 'utf8');

    expect(css).toMatch(
      /\.mndw-toolbar\s*>\s*:is\(\s*h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\)\s*\{\s*margin:\s*0\s*;\s*\}/u,
    );
  });

  it('uses declared design tokens without raw colors or var fallbacks', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/styles/kit.css'), 'utf8');
    const required = new Set<string>(TOKENS_REQUIRED);
    const undeclared: string[] = [];

    for (const match of css.matchAll(TOKEN_REFERENCE)) {
      const token = match[1];
      const kitLocalPeriod = token === '--mndw-spinner-period' || token === '--mndw-progress-period';

      if (!required.has(token) && !kitLocalPeriod) {
        undeclared.push(token);
      }

      if (token === '--mndw-spinner-period') {
        expect(match[2]).toBe(', 900ms');
        continue;
      }

      if (token === '--mndw-progress-period') {
        expect(match[2]).toBe(', 1.35s');
        continue;
      }

      expect(match[2]).not.toContain(',');
    }

    expect(undeclared).toEqual([]);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });

  it('lays switch fields out as a compact wrapping flex row while keeping messages below', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/styles/kit.css'), 'utf8');

    expect(css).toContain('.mndw-field:has(> mndw-switch)');
    expect(css).toMatch(/\.mndw-field:has\(> mndw-switch\)[\s\S]*display:\s*flex/u);
    expect(css).toMatch(/\.mndw-field:has\(> mndw-switch\)[\s\S]*flex-flow:\s*row\s+wrap/u);
    expect(css).toMatch(/\.mndw-field:has\(> mndw-switch\)[\s\S]*gap:\s*var\(--mndw-space-2\)/u);
    expect(css).not.toMatch(/\.mndw-field:has\(> mndw-switch\)[\s\S]*space-between/u);
    expect(css).toMatch(
      /\.mndw-field:has\(> mndw-switch\) > \.mndw-field__hint,[\s\S]*\.mndw-field__error[\s\S]*flex:\s*0\s+0\s+100%/u,
    );
  });

  it('uses dedicated loop periods and reduced-motion handling for spinner and progress', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/styles/kit.css'), 'utf8');

    const spinner = css.match(/\.mndw-spinner\s*\{([^}]*)\}/u)?.[1] ?? '';
    const progress = css.match(/\.mndw-progress::before\s*\{([^}]*)\}/u)?.[1] ?? '';

    expect(spinner).toContain('--mndw-spinner-period');
    expect(spinner).toMatch(/animation:\s*mndw-spin\s+var\(--mndw-spinner-period,\s*900ms\)\s+linear\s+infinite/u);
    expect(spinner).not.toMatch(/animation:[^;]*var\(--mndw-duration-/u);
    expect(progress).toContain('--mndw-progress-period');
    expect(progress).toMatch(
      /animation:\s*mndw-progress\s+var\(--mndw-progress-period,\s*1\.35s\)\s+ease-in-out\s+infinite\s+alternate/u,
    );
    expect(progress).not.toMatch(/animation:[^;]*var\(--mndw-duration-/u);

    const reducedMotion = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';

    expect(reducedMotion).toContain('.mndw-spinner');
    expect(reducedMotion).toContain('.mndw-progress::before');
    expect(reducedMotion).toMatch(/animation-duration:\s*(?:2\.4s|3s)/u);
  });
});
