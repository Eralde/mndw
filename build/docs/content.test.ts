import {existsSync, readFileSync} from 'node:fs';
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

function assertNpmOnlyCommands(page: string): void {
  const markdown = readFileSync(resolve(repoRoot, page), 'utf8');
  const exempt = contributorSection(markdown);
  const exemptStart = exempt.length > 0 ? markdown.indexOf(exempt) : -1;
  const exemptEnd = exemptStart < 0 ? -1 : exemptStart + exempt.length;
  const publicMarkdown = exempt.length > 0 ? markdown.replace(exempt, '') : markdown;

  expect(publicMarkdown, page).not.toContain('::: code-group');

  for (const block of readFencedBlocks(page, markdown)) {
    const blockStart = markdown.split('\n').slice(0, block.line - 1)
      .join('\n').length
      + (block.line > 1 ? 1 : 0);

    if (blockStart >= exemptStart && blockStart < exemptEnd) {
      continue;
    }

    expect(block.code, `${page}:${block.line}`).not.toMatch(/pnpm exec mndw|pnpm add|yarn mndw|yarn add/);
  }
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

function missingPluginFolderArguments(page: string, markdown: string): string[] {
  const errors: string[] = [];
  const commands = /\bnpx\s+mndw\s+(dev|validate|pack|zip)\b/g;
  const nonArguments = new Set(['and', 'for', 'from', 'in', 'then', 'to', 'with']);

  for (const match of markdown.matchAll(commands)) {
    const tail = markdown.slice((match.index ?? 0) + match[0].length);
    const argumentToken = /^\s+([^\s`]+)/.exec(tail)?.[1];
    const argument = argumentToken?.replace(/[.,;:!?]+$/, '');

    if (
      argument === undefined
      || (argument.length === 0 && argumentToken !== '.')
      || argument.startsWith('--')
      || nonArguments.has(argument.toLowerCase())
    ) {
      errors.push(`${page}: npx mndw ${match[1]} needs a plugin folder argument`);
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
    const setupProse = setup.replace(/```[\s\S]*?```/g, '');

    expect(setup).toContain('Node.js 22 or newer');
    expect(setup).toContain('/guides/windows');
    expect(setup).toContain('npm i -D @mndw/cli');
    expect(setup).toContain('nodeLinker: node-modules');
    expect(setup).toContain('node_modules/.bin');
    expect(setup).toContain('/install');
    expect(setup).toContain('/reference/cli');
    expect(setupProse).toContain('pnpm exec mndw');
    expect(setupProse).toContain('yarn mndw');
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

  it('uses npm-only commands in public code examples', () => {
    for (const page of authorDocPages(repoRoot)) {
      assertNpmOnlyCommands(page);
    }
  });

  it('lists every CLI command on the reference page', () => {
    const cli = readFileSync(resolve(repoRoot, 'docs/plugin-author/reference/cli.md'), 'utf8');

    for (const command of ['npx mndw create', 'npx mndw dev', 'npx mndw validate', 'npx mndw pack', 'npx mndw zip']) {
      expect(cli).toContain(command);
    }

    expect(cli).toContain('/guides/local-development');
    expect(cli).toContain('/guides/validation-and-packaging');
  });
});

describe('Task 3 and 4 sidebar documentation', () => {
  it('lists the documentation pages in the main sidebar', () => {
    const config = readFileSync(resolve(repoRoot, 'docs/plugin-author/.vitepress/config.mts'), 'utf8');
    const expectedPaths = [
      '/',
      '/install',
      '/guides/project-setup',
      '/guides/windows',
      '/tutorials/hello-widget',
      '/tutorials/rci-device-name-widget',
      '/guides/rxjs',
      '/guides/rci-api',
      '/reference/cli',
      '/api/',
    ];

    for (const path of expectedPaths) {
      expect(config).toContain(`link: '${path}'`);
    }

    expect(config).toContain('{text: \'What is mndw\', link: \'/\'}');
    expect(config).toMatch(/nav:\s*\[\s*\]/);
  });
});

describe('Task 5 author terminology', () => {
  it('does not call RCI direct', () => {
    const config = readFileSync(resolve(repoRoot, 'docs/plugin-author/.vitepress/config.mts'), 'utf8');
    const guide = readFileSync(resolve(repoRoot, 'docs/plugin-author-guide.md'), 'utf8');
    const pages = authorDocPages(repoRoot).map((page) => readFileSync(resolve(repoRoot, page), 'utf8'));

    for (const content of [...pages, config, guide]) {
      expect(content).not.toMatch(/\bdirect RCI\b/i);
    }
  });
});

describe('Project home and install pages', () => {
  function read(path: string): string {
    const absolute = resolve(repoRoot, path);

    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  }

  it('presents the project home as a regular documentation page', () => {
    const config = read('docs/plugin-author/.vitepress/config.mts');
    const home = read('docs/plugin-author/index.md');

    expect(config).toContain('title: \'mndw\'');
    expect(home).not.toMatch(/^layout:\s*home\s*$/m);
    expect(home).not.toContain('features:');
    expect(home).not.toContain('Build a plugin in your own Node.js project');
    expect(home).toContain('<HomeHero');
    expect(home).toContain('Entware');
    expect(home).toContain('curl -fsSL https://eralde.github.io/mndw-opkg-feed/add_repo.sh | sh');
    expect(home).toContain('(/install)');
    expect(home).toContain('(/guides/project-setup)');
    expect(home).not.toMatch(/^opkg\s/m);
    expect(home).not.toContain('href="/');
  });

  it('uses base-aware navigation in the home hero', () => {
    const hero = read('docs/plugin-author/.vitepress/theme/components/HomeHero.vue');

    expect(hero).toContain('VPButton');
    expect(hero).not.toContain('href="/');
  });

  it('explains install, upgrade, and dashboard troubleshooting', () => {
    const install = read('docs/plugin-author/install.md');

    expect(install).toContain('curl -fsSL https://eralde.github.io/mndw-opkg-feed/add_repo.sh | sh');
    expect(install).toContain('opkg update');
    expect(install).toContain('aarch64-3.10');
    expect(install).toContain('mips-3.4');
    expect(install).toContain('mipsel-3.4');
    expect(install).toContain('cat /opt/var/lib/mndw/frontend-port');
    expect(install).toContain('opkg upgrade mndw');
    expect(install).toContain('System update');
    expect(install).toContain('MNDW_DEVICE_PORT');
    expect(install).toContain('https://github.com/Eralde/mndw-opkg-feed');
    expect(install).toContain('/guides/validation-and-packaging');
    expect(install).toContain('First-time installs use the `curl` command above.');
    expect(install).not.toContain('opkg update && opkg install mndw');
    expect(install).not.toContain('If mndw is not installed yet');
    expect(install).not.toContain('lighttpd');
  });

  it('keeps the installation overview on the home page', () => {
    const home = readFileSync(resolve(repoRoot, 'docs/plugin-author/index.md'), 'utf8');

    expect(home).not.toMatch(/^#{1,6}\s+Before you start\s*$/m);
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

    expect(rxjs).toContain('https://learnrxjs.io');
    expect(rxjs).toContain('https://rxjs.dev/guide/overview');
    expect(rxjs).toMatch(/```ts[\s\S]*?exhaustMap\([\s\S]*?concatMap\([\s\S]*?```/);
    expect(rxjs).not.toContain('createInstance(_ctx');
  });

  it('uses firstValueFrom for one-off RCI calls and keeps stream sequencing guidance', () => {
    const rci = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/rci-api.md'), 'utf8');

    expect(rci).toContain('firstValueFrom');
    expect(rci).toContain('status: "error"');
    expect(rci).toContain('execute');
    expect(rci).toContain('queue');
    expect(rci).toContain('initBackgroundProcess');
    expect(rci).toContain('queueBackgroundProcess');
    expect(rci).toContain('https://github.com/Eralde/rci-tools/tree/master/docs');
    expect(rci).toContain('/guides/rxjs');
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
    expect(anatomy).toContain('/api/sdk#plugincontext');
    expect(anatomy).toContain('`overlay` presents modals and drawers');
    expect(anatomy).toContain('`createTicker()`');
    expect(anatomy).toContain('`pageRoute`');
    expect(anatomy).toContain('`setTileTitle`');

    const sectionOrder = [
      '## What a plugin contains',
      '## What the host provides',
      '## A plugin\'s path',
      '## Scaffold tree',
    ].map((heading) => anatomy.indexOf(heading));

    expect(sectionOrder.every((index) => index >= 0)).toBe(true);
    expect(sectionOrder).toEqual([...sectionOrder].sort((left, right) => left - right));
    expect(anatomy.indexOf('<!-- docs-check: scaffold')).toBeGreaterThan(sectionOrder[3] ?? -1);

    for (
      const contract of ['createInstance(container, ctx)', 'PluginInstance', 'unmount', 'onResize', 'mndwd', 'mndw zip']
    ) {
      expect(anatomy).toContain(contract);
    }

    for (
      const link of [
        '/guides/manifest',
        '/guides/frontend-lifecycle',
        '/guides/rci-api',
        '/guides/shell-backend',
        '/guides/validation-and-packaging',
        '/install',
      ]
    ) {
      expect(anatomy).toContain(link);
    }
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
    expect(packaging).toContain('All `@mndw/*` packages share the product version');
    expect(packaging).toContain('breaking API, manifest, or protocol changes bump the');
    expect(packaging).toContain('/guides/project-setup#package-versioning');
    expect(packaging).toContain('mndw.lock.json');
    expect(packaging).toContain('newer SDK');
    expect(packaging).toContain('major version of a host-shared dependency');
    expect(packaging).toContain('still allowed');
    expect(packaging).toContain('older SDK minor');
    expect(packaging).not.toContain('from the repository root');
  });
});

describe('Task 5 plugin CLI examples', () => {
  it('passes the plugin folder from the plugins project in public CLI examples', () => {
    const errors: string[] = [];
    const pages = authorDocPages(repoRoot);

    for (const page of pages) {
      errors.push(...missingPluginFolderArguments(page, readFileSync(resolve(repoRoot, page), 'utf8')));
    }

    expect(errors).toEqual([]);

    for (
      const path of [
        'docs/plugin-author/guides/project-setup.md',
        'docs/plugin-author/guides/local-development.md',
        'docs/plugin-author/reference/cli.md',
        'docs/plugin-author/guides/validation-and-packaging.md',
        'docs/plugin-author/guides/shell-backend.md',
        'docs/plugin-author/guides/manifest.md',
        'docs/plugin-author/install.md',
      ]
    ) {
      const markdown = readFileSync(resolve(repoRoot, path), 'utf8');

      expect(markdown, path).toContain('plugins project');
      expect(markdown, path).toContain('plugin folder');
      expect(markdown, path).not.toContain('plugin project root');
      expect(markdown, path).not.toContain('outer project');
    }

    for (
      const path of [
        'docs/plugin-author/reference/cli.md',
        'docs/plugin-author/guides/validation-and-packaging.md',
        'docs/plugin-author/guides/shell-backend.md',
        'docs/plugin-author/guides/manifest.md',
      ]
    ) {
      const markdown = readFileSync(resolve(repoRoot, path), 'utf8');

      expect(markdown, path).toContain('npx mndw validate hello-widget');
    }
  });

  it('uses the public RCI manager name in shell backend guidance', () => {
    const shell = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/shell-backend.md'), 'utf8');

    expect(shell).toContain('ctx.rciManager');
    expect(shell).not.toContain('context.rciManager');
  });
});

describe('Task 5 shared UI guide', () => {
  it('links the shared UI guide to the component reference section', () => {
    const ui = readFileSync(resolve(repoRoot, 'docs/plugin-author/guides/ui-components.md'), 'utf8');

    expect(ui).not.toContain('## Component catalog');
    expect(ui).toContain('[UI components](/ui/)');
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
