// @vitest-environment happy-dom

import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {flushSync} from 'svelte';
import {afterEach, describe, expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {packPlugin} from './pack.js';

const temporaryDirectories: string[] = [];

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mndw-svelte-i18n-probe-'));

  temporaryDirectories.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'i18n'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'svelte-probe', version: '0.1.0'}));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      name: 'svelte-probe',
      version: '0.1.0',
      type: 'widget',
      label: 'Svelte Probe',
      entry: 'index.js',
      size: {w: 4, h: 3},
      i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'}},
    }),
  );
  writeFileSync(join(root, 'i18n/en.json'), JSON.stringify({l10n: {probe: 'English probe'}}));
  writeFileSync(join(root, 'i18n/ru.json'), JSON.stringify({l10n: {probe: 'Русский probe'}}));
  writeFileSync(
    join(root, 'src/App.svelte'),
    `<script lang="ts">
import {createTranslator} from '@mndw/sdk/svelte';
import type {PluginI18n} from '@mndw/sdk';

let {i18n}: {i18n: PluginI18n} = $props();
const translator = createTranslator(i18n);
</script>

<span data-testid="l10n-probe">{$translator.t('l10n.probe')}</span>
`,
  );
  writeFileSync(
    join(root, 'src/index.ts'),
    `import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import App from './App.svelte';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: el, props: {i18n: ctx.i18n}});
  return {unmount: () => void unmount(app)};
}
`,
  );

  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('Svelte i18n pack path', () => {
  it('updates the same DOM node after a packed locale change', async () => {
    const source = createFixture();
    const outDir = join(source, 'dist');
    const result = await packPlugin(source, {outDir});
    const bundleSource = readFileSync(result.entryPath, 'utf8');
    const bundle = await import(`data:text/javascript;base64,${Buffer.from(bundleSource).toString('base64')}`) as {
      createInstance: (host: HTMLElement, context: PluginContext) => PluginInstance;
    };
    const i18n = createTestI18n({l10n: {probe: 'English probe'}}, 'en');
    const host = document.createElement('div');
    const context = {i18n} as unknown as PluginContext;

    const instance = bundle.createInstance(host, context);

    flushSync();

    const node = host.querySelector('[data-testid="l10n-probe"]');
    const enValue = i18n.t('l10n.probe');
    const ruValue = 'Русский probe';

    expect(enValue).not.toBe(ruValue);
    expect(node?.textContent).toBe(enValue);
    i18n.setLocale('ru', {l10n: {probe: ruValue}});
    await Promise.resolve();
    flushSync();

    expect(host.querySelector('[data-testid="l10n-probe"]')).toBe(node);
    expect(node?.textContent).toBe(ruValue);
    void instance.unmount();
  });

  it('writes a packed manifest and catalogs from the fixture', async () => {
    const source = createFixture();
    const result = await packPlugin(source, {outDir: join(source, 'dist')});

    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
      i18n: {locales: Record<string, string>};
    };

    expect(manifest.i18n.locales.ru).toBe('i18n/ru.json');
  });
});
