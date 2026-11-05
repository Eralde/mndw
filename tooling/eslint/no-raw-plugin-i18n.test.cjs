'use strict';

const {RuleTester} = require('eslint');
const tseslint = require('typescript-eslint');
const rule = require('./no-raw-plugin-i18n.cjs');

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: {
        allowDefaultProject: [
          'plugins/builtin/rule-fixture/src/*.ts',
          'plugins/builtin/rule-fixture/src/*.svelte',
          'frontend/sdk/src/testing/*.ts',
        ],
        defaultProject: './tsconfig.base.json',
      },
      extraFileExtensions: ['.svelte'],
      tsconfigRootDir: process.cwd(),
    },
  },
});

tester.run('no-raw-plugin-i18n', rule, {
  valid: [
    {
      filename: 'plugins/builtin/rule-fixture/src/translator.ts',
      code: `
        import type {PluginI18n, Translator} from '@mndw/sdk';
        declare const i18n: PluginI18n;
        declare const translator: Translator;
        translator.t('title');
        i18n.change$.subscribe(() => {});
        i18n.locale;
        i18n.direction;
      `,
    },
    {
      filename: 'plugins/builtin/rule-fixture/src/Component.svelte',
      code: `
        import type {Readable} from 'svelte/store';
        import type {Translator} from '@mndw/sdk';
        declare const $translator: Translator;
        declare const translator: Readable<Translator>;
        $translator.t('title');
        translator.subscribe(() => {});
      `,
    },
    {
      filename: 'plugins/builtin/rule-fixture/src/render.ts',
      code: `
        import type {PluginI18n} from '@mndw/sdk';
        declare const i18n: PluginI18n;
        i18n.t('title');
        i18n.formatDate(new Date());
      `,
    },
    {
      filename: 'plugins/builtin/mws-page/src/mws-map-instance.ts',
      code: `
        import type {PluginI18n} from '@mndw/sdk';
        declare const ctx: {i18n: PluginI18n};
        ctx.i18n.t('title');
        ctx.i18n.change$.subscribe(() => {});
      `,
    },
    {
      filename: 'plugins/builtin/rule-fixture/src/i18n-helper.ts',
      code: `
        const i18n = {t: (key: string) => key};
        i18n.t('title');
      `,
    },
  ],
  invalid: [
    {
      filename: 'plugins/builtin/rule-fixture/src/raw.ts',
      code: `
        import type {PluginI18n} from '@mndw/sdk';
        declare const i18n: PluginI18n;
        i18n.t('title');
        i18n.formatNumber(1);
        i18n.formatDate(new Date());
      `,
      errors: [{messageId: 'rawPluginI18n'}, {messageId: 'rawPluginI18n'}, {messageId: 'rawPluginI18n'}],
    },
    {
      filename: 'plugins/builtin/rule-fixture/src/raw.ts',
      code: `
        import type {PluginI18n} from '@mndw/sdk';
        declare const props: {i18n: PluginI18n};
        declare class Component {
          private readonly i18n: PluginI18n;
          public render(): string {
            return this.i18n.formatDate(new Date());
          }
        }
        props.i18n.t('title');
        new Component().render();
      `,
      errors: [{messageId: 'rawPluginI18n'}, {messageId: 'rawPluginI18n'}],
    },
    {
      filename: 'plugins/builtin/rule-fixture/src/raw.ts',
      code: `
        import type {PluginI18n} from '@mndw/sdk';
        declare const ctx: {i18n: PluginI18n};
        ctx.i18n.t('title');
      `,
      errors: [{messageId: 'rawPluginI18n'}],
    },
    {
      filename: 'plugins/builtin/rule-fixture/src/raw.ts',
      code: `
        import type {PluginI18n} from '@mndw/sdk';
        declare const i18n: PluginI18n;
        const {t} = i18n;
        t('title');
      `,
      errors: [{messageId: 'rawPluginI18n'}],
    },
    {
      filename: 'plugins/builtin/rule-fixture/src/raw.ts',
      code: `
        import type {PluginI18n} from '@mndw/sdk';
        declare const i18n: PluginI18n;
        const t = i18n.t;
        t('title');
      `,
      errors: [{messageId: 'rawPluginI18n'}],
    },
  ],
});
