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

  it('uses declared design tokens without raw colors or var fallbacks', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/styles/kit.css'), 'utf8');
    const required = new Set<string>(TOKENS_REQUIRED);
    const undeclared: string[] = [];

    for (const match of css.matchAll(TOKEN_REFERENCE)) {
      const token = match[1];

      if (!required.has(token)) {
        undeclared.push(token);
      }

      expect(match[2]).not.toContain(',');
    }

    expect(undeclared).toEqual([]);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });
});
