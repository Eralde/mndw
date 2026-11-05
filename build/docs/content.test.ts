import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {authorDocPages, readFencedBlocks} from './markdown-blocks.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const removedNames = [
  'onThemeChange',
  'onPaletteChange',
  'getTokens',
  'hostInfo',
  'i18n.onChange',
  'events.subscribe',
  'onResync',
  'fetchAll',
  '@mndw/sdk/ticker',
  'new Ticker',
  '--host-device',
];

function contributorSection(markdown: string): string {
  const heading = /^## Working in a clone of mndw\s*$/m.exec(markdown);

  if (heading === null) {
    return '';
  }

  const start = heading.index + heading[0].length;
  const nextHeading = /^## /m.exec(markdown.slice(start));

  return markdown.slice(start, nextHeading === null ? undefined : start + nextHeading.index);
}

function contentErrors(page: string, markdown: string): string[] {
  const exempt = contributorSection(markdown);
  const blocks = readFencedBlocks(page, markdown);
  const errors: string[] = [];
  const exemptStart = exempt.length > 0 ? markdown.indexOf(exempt) : -1;
  const exemptEnd = exemptStart < 0 ? -1 : exemptStart + exempt.length;

  for (const name of removedNames) {
    if (markdown.includes(name)) {
      errors.push(`removed name: ${name}`);
    }
  }

  for (const match of markdown.matchAll(/workspace:\*/g)) {
    const offset = match.index ?? -1;

    if (offset < exemptStart || offset >= exemptEnd) {
      errors.push('workspace:* outside contributor section');
      break;
    }
  }

  for (const block of blocks) {
    const blockOffset = markdown.split('\n').slice(0, block.line - 1)
      .join('\n').length + (block.line > 1 ? 1 : 0);
    const isInExempt = blockOffset >= exemptStart && blockOffset < exemptEnd;

    if ((block.code.includes('--filter') || block.code.includes('@mndw/cli exec')) && !isInExempt) {
      errors.push(`workspace-only command at ${block.line}`);
    }
  }

  if (
    page !== 'docs/plugin-author/guides/windows.md'
    && blocks.some((block) => /--backend\s+(?:sh|go)(?:\s|$)/.test(block.code))
  ) {
    const firstFence = blocks[0]?.line ?? Number.POSITIVE_INFINITY;
    const beforeFence = markdown.split('\n').slice(0, firstFence - 1)
      .join('\n');

    if (!beforeFence.includes('/guides/windows')) {
      errors.push('missing Windows link before first fenced block');
    }
  }

  return errors;
}

describe('author documentation content constraints', () => {
  it('allows workspace syntax inside the contributor section', () => {
    const markdown =
      '## Working in a clone of mndw\nUse workspace:* and pnpm --filter @mndw/cli exec.\n\n```sh\ntrue\n```';

    expect(contentErrors('docs/plugin-author/contributing.md', markdown)).toEqual([]);
  });

  it('rejects workspace-only commands outside the contributor section', () => {
    const markdown = '```sh\npnpm --filter @mndw/cli exec mndw validate .\n```\n';

    expect(contentErrors('docs/plugin-author/guides/manifest.md', markdown)).toContain(
      'workspace-only command at 1',
    );
  });

  it('requires a Windows link before backend instructions', () => {
    const missing = '```sh\nnpx mndw create demo --backend sh\n```';
    const linked = '[Windows setup](/guides/windows)\n\n```sh\nnpx mndw create demo --backend sh\n```';

    expect(contentErrors('docs/plugin-author/guides/shell-backend.md', missing)).toContain(
      'missing Windows link before first fenced block',
    );
    expect(contentErrors('docs/plugin-author/guides/shell-backend.md', linked)).toEqual([]);
  });

  it('checks only non-pending pages', () => {
    const errors: string[] = [];

    for (const page of authorDocPages(repoRoot)) {
      errors.push(...contentErrors(page, readFileSync(resolve(repoRoot, page), 'utf8')));
    }

    expect(errors).toEqual([]);
  });
});

describe('Task 3 and 4 author pages', () => {
  it('documents the published project setup and Windows workflow', () => {
    const setup = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/project-setup.md'), 'utf8');
    const windows = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/windows.md'), 'utf8');

    expect(setup).toContain('Node.js 22 or newer');
    expect(setup).toContain('/guides/windows');
    expect(setup).toContain('npm i -D @mndw/cli');
    expect(setup).toContain('pnpm add -D @mndw/cli');
    expect(setup).toContain('yarn add -D @mndw/cli');
    expect(setup).toContain('nodeLinker: node-modules');
    expect(windows).toContain('0755');
    expect(windows).toContain(
      'mndw dev: plugins with a backend need WSL on Windows. Open a WSL terminal and run mndw dev there.',
    );
    expect(windows).toContain('not under `/mnt/c/`');
    expect(windows).toContain('win32/arm64');
  });

  it('explains public local development and isolates clone-only instructions', () => {
    const markdown = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/local-development.md'), 'utf8');
    const clone = contributorSection(markdown);

    expect(markdown).toContain('npx mndw dev hello-widget');
    expect(markdown).toContain('pnpm exec mndw dev hello-widget');
    expect(markdown).toContain('yarn mndw dev hello-widget');
    expect(markdown).toContain('--addr <device>');
    expect(markdown).toContain('stub device');
    expect(markdown).toContain('5173');
    expect(markdown).toContain('9090');
    expect(markdown).toContain('Vite');
    expect(markdown).toContain('hot module replacement');
    expect(clone).toContain('pnpm exec mndw');
    expect(clone).toContain('--out plugins/examples/<name>');
    expect(clone).toContain('workspace:*');
    expect(clone).toContain('go run');
    expect(clone).toContain('https://github.com/Eralde/mndw/blob/master/README.md#quick-start');
    expect(clone.split('\n').length).toBeLessThanOrEqual(15);
  });

  it('adds the published RxJS guide to author navigation in Task 4', () => {
    const index = readFileSync(resolve(repoRoot, 'docs/plugin-author/index.md'), 'utf8');
    const config = readFileSync(resolve(repoRoot, 'docs/plugin-author/.vitepress/config.mts'), 'utf8');
    const sidebar = config.slice(config.indexOf('sidebar:'));
    const startIndex = sidebar.indexOf('Start');
    const tutorialsIndex = sidebar.indexOf('Tutorials');
    const guidesIndex = sidebar.indexOf('Guides');

    expect(index).toContain('[RxJS for plugin authors](/guides/rxjs)');
    expect(config).toContain('{text: \'RxJS for plugin authors\', link: \'/guides/rxjs\'}');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(tutorialsIndex).toBeGreaterThan(startIndex);
    expect(guidesIndex).toBeGreaterThan(tutorialsIndex);
    expect(config).toMatch(/\{text: 'Project setup', link: '\/guides\/project-setup'\}/);
    expect(config).toMatch(/\{text: 'Windows', link: '\/guides\/windows'\}/);
  });
});

describe('Task 4 Observable contract docs', () => {
  it('documents SDK streams, helpers, and lifecycle cleanup', () => {
    const lifecycle = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/frontend-lifecycle.md'), 'utf8');

    for (
      const stream of [
        'ctx.theme$',
        'ctx.locale$',
        'ctx.palette$',
        'ctx.i18n.change$',
        'ctx.pageRoute.childPath$',
        'ctx.events?.select$',
        'ctx.events?.resync$',
        'ticker.tick$',
      ]
    ) {
      expect(lifecycle).toContain(stream);
    }

    expect(lifecycle).toContain('current value on subscribe');
    expect(lifecycle).toContain('host completes every stream');
    expect(lifecycle).toContain('ctx.createTicker()');
    expect(lifecycle).toContain('ctx.telemetry.fetchProjected');
    expect(lifecycle).toContain('useObservable');
    expect(lifecycle).toContain('useTheme');
    expect(lifecycle).toContain('useLocale');
    expect(lifecycle).toContain('useTranslator');
    expect(lifecycle).toContain('toSignal');
    expect(lifecycle).toContain('createTranslatorSignals');
  });

  it('explains RxJS basics, cleanup, one-off RCI, and linked operators', () => {
    const rxjs = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/rxjs.md'), 'utf8');

    expect(rxjs).toContain('Observable');
    expect(rxjs).toContain('Promise');
    expect(rxjs).toContain('firstValueFrom(ctx.rciManager.queue({path: \'show.version\'}))');
    expect(rxjs).toContain('subscription.unsubscribe()');

    for (const operator of ['map', 'filter', 'switchMap', 'exhaustMap', 'concatMap', 'catchError', 'takeUntil']) {
      expect(rxjs).toContain(`https://rxjs.dev/api/operators/${operator}`);
    }
  });

  it('uses firstValueFrom for one-off RCI calls and keeps stream sequencing guidance', () => {
    const rci = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/rci-api.md'), 'utf8');

    expect(rci).toContain('firstValueFrom');
    expect(rci).toContain('exhaustMap');
    expect(rci).toContain('switchMap');
    expect(rci).toContain('execute');
    expect(rci).toContain('queueBackgroundProcess');
    expect(rci).not.toContain('rciManager.destroy');
  });

  it('uses live palette and theme context after CSS tokens', () => {
    const styling = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/styling-and-ui.md'), 'utf8');

    expect(styling.indexOf('Use CSS tokens')).toBeLessThan(styling.indexOf('ctx.palette'));
    expect(styling).toContain('palette$');
    expect(styling).toContain('theme$');
    expect(styling).not.toContain('getTokens');
    expect(styling).not.toContain('onPaletteChange');
  });
});

describe('Task 5 plugin reference guides', () => {
  it('checks the real scaffold and explains the published npm package', () => {
    const anatomy = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/plugin-anatomy.md'), 'utf8');

    expect(anatomy).toContain(
      '<!-- docs-check: scaffold hello-widget --type widget --framework svelte --backend sh -->',
    );
    expect(anatomy).toContain('package.json` is the plugin npm package');
    expect(anatomy).toContain('@mndw/sdk');
    expect(anatomy).toContain('@mndw/ui');
    expect(anatomy).toContain('framework wrapper');
    expect(anatomy).toContain('`dist/`');
  });

  it('documents the published schema path and unknown manifest keys', () => {
    const manifest = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/manifest.md'), 'utf8');

    expect(manifest).toContain('./node_modules/@mndw/sdk/manifest.schema.json');
    expect(manifest).toContain('unknown top-level keys');
    expect(manifest).not.toContain('frontend/sdk-internal/src/manifest-schema.ts');
  });

  it('documents public validate, pack, zip commands and version warnings', () => {
    const packaging = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/validation-and-packaging.md'), 'utf8');

    expect(packaging).toContain('npx mndw validate');
    expect(packaging).toContain('npx mndw pack');
    expect(packaging).toContain('npx mndw zip');
    expect(packaging).toContain('0755');
    expect(packaging).toContain('context contract version');
    expect(packaging).toContain('mndw.lock.json');
    expect(packaging).toContain('newer SDK');
    expect(packaging).toContain('major version of a host-shared dependency');
    expect(packaging).toContain('still allowed');
    expect(packaging).toContain('older SDK minor');
  });

  it('uses public commands and documents framework table cells', () => {
    const shell = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/shell-backend.md'), 'utf8');
    const ui = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/ui-components.md'), 'utf8');

    expect(shell).toContain('/guides/windows');
    expect(shell).toContain('npx mndw');
    expect(ui).toContain('come from npm');
    expect(ui).toContain('svelteCell');
    expect(ui).toContain('vueCell');
    expect(ui).toContain('MndwTableDirective');
    expect(ui).toContain('<ng-template mndwCell');
    expect(ui).toContain('angularCell');
  });
});
