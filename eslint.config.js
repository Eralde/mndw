// @ts-check

const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const {fixupPluginRules} = require('@eslint/compat');
const stylistic = require('@stylistic/eslint-plugin');
const _import = require('eslint-plugin-import');
const jsdoc = require('eslint-plugin-jsdoc');
const preferArrow = require('eslint-plugin-prefer-arrow');
const svelteParser = require('svelte-eslint-parser');
const sveltePlugin = require('eslint-plugin-svelte');
const vueParser = require('vue-eslint-parser');
const vuePlugin = require('eslint-plugin-vue');
const angularEslintPlugin = require('@angular-eslint/eslint-plugin');
const noRawPluginI18n = require('./tooling/eslint/no-raw-plugin-i18n.cjs');
const {isMndwButtonA11yWarning} = require('./build/svelte-compiler-options.js');

const OFF = 'off';
const WARN = 'warn';
const ERROR = 'error';

// ------------------------------------
// ESLint rule overrides
// ------------------------------------
const JS_RULE_OVERRIDES = {
  'arrow-parens': OFF,
  'jsdoc/check-alignment': ERROR,
  'new-parens': ERROR,
  'no-multiple-empty-lines': OFF,
  'sort-keys': OFF,
  'complexity': OFF,
  'constructor-super': ERROR,
  'max-classes-per-file': OFF,
  'no-cond-assign': ERROR,
  'no-invalid-this': OFF,
  'no-unsafe-finally': ERROR,
  'use-isnan': ERROR,
  'valid-typeof': OFF,

  'space-before-function-paren': OFF,
  'brace-style': OFF,
  'curly': ERROR,
  'eol-last': ERROR,
  'eqeqeq': [ERROR, 'always'],
  'guard-for-in': ERROR,
  'id-blacklist': [1, 'e', 'cb', 'x'],
  'id-match': OFF,
  'import/no-deprecated': WARN,
  'jsdoc/no-types': ERROR,

  'max-len': [OFF],

  'max-lines-per-function': [
    WARN,
    {
      'max': 75,
    },
  ],

  'no-bitwise': ERROR,
  'no-caller': ERROR,

  'no-debugger': ERROR,
  'no-duplicate-imports': ERROR,
  'no-empty': OFF,
  'no-eval': ERROR,
  'no-fallthrough': ERROR,
  'no-new-wrappers': ERROR,
  'no-restricted-imports': [ERROR, 'rxjs/Rx'],
  'no-throw-literal': ERROR,

  'no-trailing-spaces': [
    ERROR,
    {
      'ignoreComments': true,
    },
  ],

  'no-undef-init': ERROR,
  'no-underscore-dangle': OFF,
  'no-unused-labels': ERROR,
  'no-var': ERROR,
  'prefer-const': ERROR,
  'radix': ERROR,

  'spaced-comment': [
    ERROR,
    'always',
    {
      'markers': ['/'],
    },
  ],

  'arrow-body-style': OFF,
  'quote-props': [WARN, 'consistent-as-needed'],
  'prefer-arrow/prefer-arrow-functions': [OFF],
  'object-shorthand': OFF,
  'quotes': [ERROR, 'single'],
  'object-curly-spacing': [ERROR, 'never'],

  'padding-line-between-statements': [
    WARN,
    {
      blankLine: 'always',
      prev: '*',
      next: 'return',
    },
    {
      blankLine: 'always',
      prev: 'block-like',
      next: 'const',
    },
    {
      blankLine: 'always',
      prev: 'block-like',
      next: 'let',
    },
    {
      blankLine: 'always',
      prev: '*',
      next: ['const', 'let', 'var', 'export'],
    },
    {
      blankLine: 'always',
      prev: ['const', 'let', 'var', 'export'],
      next: '*',
    },
    {
      blankLine: 'any',
      prev: ['const', 'let', 'var', 'export'],
      next: ['const', 'let', 'var', 'export'],
    },
    {
      blankLine: 'always',
      prev: '*',
      next: ['if', 'class', 'for', 'do', 'while', 'switch', 'try'],
    },
    {
      blankLine: 'always',
      prev: ['if', 'class', 'for', 'do', 'while', 'switch', 'try'],
      next: '*',
    },
  ],

  'no-useless-escape': OFF,

  'comma-dangle': OFF,

  'jsdoc/newline-after-description': OFF,

  'one-var': OFF,
  'newline-per-chained-call': WARN,

  // @stylistic rule overrides
  '@stylistic/quotes': [ERROR, 'single'],
  '@stylistic/semi': OFF,
  '@stylistic/type-annotation-spacing': ERROR,
  '@stylistic/member-delimiter-style': [
    ERROR,
    {
      'multiline': {
        'delimiter': 'semi',
        'requireLast': true,
      },

      'singleline': {
        'delimiter': 'semi',
        'requireLast': false,
      },
    },
  ],
};

// ------------------------------------
// `@typescript-eslint` rule overrides
// ------------------------------------
const TS_RULE_OVERRIDES = {
  '@typescript-eslint/array-type': OFF,
  '@typescript-eslint/interface-name-prefix': OFF,
  '@typescript-eslint/no-empty-function': OFF,
  '@typescript-eslint/no-explicit-any': OFF,
  '@typescript-eslint/no-inferrable-types': OFF,
  '@typescript-eslint/no-non-null-assertion': ERROR,
  '@typescript-eslint/no-parameter-properties': OFF,
  '@typescript-eslint/no-unsafe-assignment': OFF,
  '@typescript-eslint/no-var-requires': OFF,
  '@typescript-eslint/prefer-regexp-exec': OFF,
  '@typescript-eslint/restrict-plus-operands': OFF,
  '@typescript-eslint/restrict-template-expressions': OFF,
  '@typescript-eslint/no-redundant-type-constituents': OFF, // incorrectly handles `<some_type> | null`
  'dot-notation': OFF,
  '@typescript-eslint/dot-notation': WARN,

  '@typescript-eslint/explicit-member-accessibility': [
    WARN,
    {
      'accessibility': 'explicit',

      'overrides': {
        'constructors': 'no-public',
      },
    },
  ],

  '@typescript-eslint/indent': OFF,
  '@typescript-eslint/member-ordering': OFF,

  '@typescript-eslint/naming-convention': [
    ERROR,
    {
      'selector': 'variable',
      'format': ['camelCase', 'UPPER_CASE'],
      'filter': 'NDM',
    },
    {
      'selector': 'enum',
      'format': ['UPPER_CASE'],
    },
    {
      'selector': 'class',
      'format': ['StrictPascalCase'],
      'leadingUnderscore': 'allow',
    },
    {
      'selector': 'interface',
      'format': ['StrictPascalCase'],
      'leadingUnderscore': 'allow',
    },
  ],

  '@typescript-eslint/unified-signatures': ERROR,

  '@typescript-eslint/unbound-method': [
    ERROR,
    {
      'ignoreStatic': true,
    },
  ],

  'no-shadow': OFF,
  '@typescript-eslint/no-shadow': [ERROR],
  'no-use-before-define': OFF,
  '@typescript-eslint/no-use-before-define': WARN,
  '@typescript-eslint/consistent-type-assertions': OFF,

  // requires `strictNullChecks`
  '@typescript-eslint/prefer-nullish-coalescing': OFF,

  '@typescript-eslint/no-unused-vars': [
    ERROR,
    {
      'args': 'all',
      'argsIgnorePattern': '^_',
      'caughtErrors': 'all',
      'caughtErrorsIgnorePattern': '^_',
      'destructuredArrayIgnorePattern': '^_',
      'varsIgnorePattern': '^_',
      'ignoreRestSiblings': true,
    },
  ],
};

module.exports = tseslint.config(
  // Scaffolding templates are opaque source text (they carry placeholder tokens and reference deps a
  // scaffolded plugin installs, not the host), so keep them out of every lint pass.
  {
    ignores: [
      'frontend/host/scripts/templates/**',
      'tooling/cli/templates/**',
      // CLI fixture packages are test input, not host source — never lint their payloads.
      'tooling/cli/fixtures/**',
      // Built example-plugin bundles (esbuild output) are not source — never lint them.
      'plugins/builtin/dist/**',
      'plugins/builtin/*/dist/**',
    ],
  },
  // @see https://typescript-eslint.io/getting-started/typed-linting/
  {
    languageOptions: {
      'sourceType': 'module',

      parserOptions: {
        'tsconfigRootDir': __dirname,
      },
    },
  },
  {
    files: ['**/*.ts'],
    ignores: [
      'frontend/*/scripts/**/*.ts',
      'frontend/*/vite.config.ts',
      'frontend/*/vitest.config.ts',
      'tooling/*/scripts/**/*.ts',
      'tooling/*/vite.config.ts',
      'tooling/*/vitest.config.ts',
      'build/palette/scripts/**/*.ts',
      'build/palette/playground/**/*.ts',
      'build/palette/vite.config.ts',
      'build/palette/vitest.config.ts',
      'frontend/sdk/src/tokens.ts',
      '**/*.vue',
      '**/*.svelte.ts',
    ],
    languageOptions: {
      parserOptions: {
        'project': [
          './frontend/*/tsconfig.json',
          './tooling/*/tsconfig.json',
          './build/tsconfig.json',
          './build/palette/tsconfig.json',
          './tsconfig.example-plugins.json',
        ],
      },
    },
    extends: [
      eslint.configs.recommended,

      // https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/eslint-plugin/src/configs/eslintrc/recommended-type-checked.ts
      ...tseslint.configs.recommendedTypeChecked,

      // https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/eslint-plugin/src/configs/eslintrc/stylistic-type-checked.ts
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: {
      import: fixupPluginRules(_import),
      jsdoc,
      'prefer-arrow': preferArrow,
      '@stylistic': stylistic,
    },

    rules: {
      ...JS_RULE_OVERRIDES,
      ...TS_RULE_OVERRIDES,
    },
  },
  // Example plugins: relax type-aware strictness for D3 and Vue h() patterns
  {
    files: ['plugins/builtin/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': OFF,
      '@typescript-eslint/no-unsafe-member-access': OFF,
      '@typescript-eslint/no-unsafe-return': OFF,
      '@typescript-eslint/no-unsafe-argument': OFF,
      '@typescript-eslint/explicit-member-accessibility': OFF,
      '@typescript-eslint/no-floating-promises': OFF,
      '@typescript-eslint/no-misused-promises': OFF,
      'max-lines-per-function': OFF,
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        svelteConfig: {
          warningFilter: (warning) => !isMndwButtonA11yWarning(warning),
        },
        projectService: {
          allowDefaultProject: [
            'plugins/builtin/*/src/components/*.svelte',
            'plugins/builtin/*/src/*.svelte',
          ],
          defaultProject: './tsconfig.example-plugins.json',
        },
        extraFileExtensions: ['.svelte'],
        tsconfigRootDir: __dirname,
      },
    },
    extends: [
      // eslint-plugin-svelte provides flat config presets
      sveltePlugin.configs['flat/recommended'],
    ],
    rules: {
      // Relax rules that conflict with Svelte template syntax
      'no-unused-vars': OFF,
      'no-undef': OFF, // Svelte compiler generates variables from exports
      '@typescript-eslint/no-unused-vars': OFF,

      // Svelte 5 runes
      'svelte/no-unused-svelte-ignore': ERROR,
      'svelte/valid-compile': ERROR,
      'svelte/no-at-html-tags': WARN,

      // Svelte 5 runes: $state, $derived, $effect are globals
      'svelte/no-immutable-reactive-statements': WARN,
    },
  },
  // Vue SFC files
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        sourceType: 'module',
        project: null,
      },
    },
    plugins: {
      vue: vuePlugin,
    },
    rules: {
      ...vuePlugin.configs['flat/essential'].rules,
      'no-unused-vars': OFF,
      '@typescript-eslint/no-unused-vars': OFF,
    },
  },
  // Reactive l10n enforcement for migrated framework plugin surfaces. Vanilla render modules and
  // the MWS map adapter are explicit, audited exemptions in no-raw-plugin-i18n.cjs. Vue remains
  // outside typed enforcement because its SFC parser configuration has no TypeScript project.
  {
    files: [
      'frontend/host/src/**/*.svelte',
      'plugins/builtin/ping-widget/src/**/*.{ts,svelte}',
      'plugins/builtin/system-log-page/src/**/*.{ts,svelte}',
      'plugins/builtin/terminal-page/src/**/*.{ts,svelte}',
      'plugins/builtin/device-traffic-widget/src/**/*.{ts,svelte}',
      'plugins/builtin/clients-widget/src/**/*.{ts,vue}',
      'plugins/builtin/device-info-widget/src/**/*.{ts,vue}',
      'plugins/builtin/mws-page/src/**/*.ts',
      'plugins/builtin/tx-rx-chart-widget/src/**/*.ts',
    ],
    plugins: {
      mndw: {
        rules: {
          'no-raw-plugin-i18n': noRawPluginI18n,
        },
      },
    },
    rules: {
      'mndw/no-raw-plugin-i18n': ERROR,
    },
  },
  // Angular plugin: relax rules only for the Angular widget
  {
    files: ['plugins/builtin/tx-rx-chart-widget/src/**/*.ts'],
    plugins: {
      '@angular-eslint': angularEslintPlugin,
    },
    rules: {
      '@angular-eslint/component-selector': OFF,
      '@angular-eslint/directive-selector': OFF,
      '@angular-eslint/use-lifecycle-interface': WARN,
      '@angular-eslint/prefer-standalone': WARN,
    },
  },
);
