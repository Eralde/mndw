import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {beforeAll, describe, expect, it} from 'vitest';

import {authorDocPages, readFencedBlocks} from './markdown-blocks.js';

interface SnippetCase {
  readonly page: string;
  readonly line: number;
  readonly source: string;
  readonly shouldPass: boolean;
}

interface SnippetDiagnostic {
  readonly page: string;
  readonly line: number;
  readonly message: string;
}

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const snippetRoot = resolve(repoRoot, 'build/docs-snippet-env');
const prelude = [
  'export {};',
  'declare const ctx: import("@mndw/sdk").PluginContext;',
  'declare const container: HTMLElement;',
  '',
].join('\n');
const preludeLines = prelude.split('\n').length - 1;
let results: Map<string, SnippetDiagnostic[]>;

function diagnosticKey(snippet: SnippetCase): string {
  return `${snippet.page}:${snippet.line}`;
}

function compileCases(snippets: SnippetCase[]): Map<string, SnippetDiagnostic[]> {
  const configPath = resolve(snippetRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));

  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, snippetRoot, {noEmit: true}, configPath);
  const virtualFiles = new Map<string, string>();

  for (const [index, snippet] of snippets.entries()) {
    const virtualPath = resolve(snippetRoot, `__snippet-${index}.ts`);

    virtualFiles.set(virtualPath, `${prelude}${snippet.source}`);
  }

  const baseHost = ts.createCompilerHost(parsed.options);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (path: string): boolean => virtualFiles.has(resolve(path)) || baseHost.fileExists(path),
    readFile: (path: string): string | undefined => virtualFiles.get(resolve(path)) ?? baseHost.readFile(path),
    getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) => {
      const virtualSource = virtualFiles.get(resolve(path));

      if (virtualSource !== undefined) {
        return ts.createSourceFile(path, virtualSource, languageVersion);
      }

      return baseHost.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };

  const program = ts.createProgram({rootNames: [...parsed.fileNames, ...virtualFiles.keys()], options: parsed.options,
    host});
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  const result = new Map<string, SnippetDiagnostic[]>();

  for (const diagnostic of diagnostics) {
    if (diagnostic.file === undefined) {
      for (const snippet of snippets) {
        const key = diagnosticKey(snippet);
        const errors = result.get(key) ?? [];

        errors.push({
          page: snippet.page,
          line: snippet.line,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        });
        result.set(key, errors);
      }

      continue;
    }

    if (!virtualFiles.has(resolve(diagnostic.file.fileName))) {
      continue;
    }

    const index = [...virtualFiles.keys()].findIndex((path) => path === resolve(diagnostic.file?.fileName ?? ''));
    const snippet = snippets[index];

    if (snippet === undefined) {
      continue;
    }

    const position = diagnostic.start === undefined
      ? undefined
      : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const line = snippet.line + (position?.line ?? 0) - preludeLines;
    const key = diagnosticKey(snippet);
    const errors = result.get(key) ?? [];

    errors.push({
      page: snippet.page,
      line,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    });
    result.set(key, errors);
  }

  return result;
}

const fixtureCases: SnippetCase[] = [
  {page: 'docs/plugin-author/fixture.md', line: 1, source: 'ctx.onThemeChange(() => {});', shouldPass: false},
  {page: 'docs/plugin-author/fixture.md', line: 5,
    source: 'import {svelteCell} from "@mndw/ui-svelte";\nvoid svelteCell;', shouldPass: true},
  {page: 'docs/plugin-author/fixture.md', line: 10,
    source: 'import {svelte} from "@sveltejs/vite-plugin-svelte";\nvoid svelte;', shouldPass: true},
  {page: 'docs/plugin-author/fixture.md', line: 15, source: 'import App from "./App.svelte";\nvoid App;',
    shouldPass: true},
];

describe('TypeScript documentation snippets', () => {
  beforeAll(() => {
    const realCases: SnippetCase[] = [];

    for (const page of authorDocPages(repoRoot)) {
      const markdown = readFileSync(resolve(repoRoot, page), 'utf8');

      for (const block of readFencedBlocks(page, markdown)) {
        if (
          !['ts', 'typescript'].includes(block.lang) || block.directive?.kind === 'skip'
          || block.directive?.kind === 'file'
        ) {
          continue;
        }

        realCases.push({page, line: block.line, source: block.code, shouldPass: true});
      }
    }

    results = compileCases([...fixtureCases, ...realCases]);
  }, 180_000);

  for (const snippet of fixtureCases) {
    it(`${snippet.shouldPass ? 'accepts' : 'rejects'} fixture at ${snippet.page}:${snippet.line}`, () => {
      const diagnostics = results.get(diagnosticKey(snippet)) ?? [];

      expect(diagnostics.length > 0).toBe(!snippet.shouldPass);
    }, 120_000);
  }

  it('type-checks each non-pending TypeScript block and reports page lines', () => {
    const failures = [...results.values()].flat().map((diagnostic) =>
      `${diagnostic.page}:${diagnostic.line}: ${diagnostic.message}`
    );
    const actualFailures = failures.filter((failure) => !failure.startsWith('docs/plugin-author/fixture.md:1:'));

    expect(actualFailures).toEqual([]);
  }, 120_000);
});
