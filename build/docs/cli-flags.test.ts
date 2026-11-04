import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {createProgram} from '../../tooling/cli/src/index.js';
import {authorDocPages, readFencedBlocks} from './markdown-blocks.js';

interface InvocationError {
  readonly command: string;
  readonly flag?: string;
}

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const commandTree = createProgram();

function optionsFor(commandName: string): Set<string> {
  const command = commandTree.commands.find((item) => item.name() === commandName);

  if (command === undefined) {
    return new Set();
  }

  return new Set(command.options.filter((option) => option.hidden !== true).map((option) => option.long));
}

function shellCommands(block: string, lang: string): string[] {
  const continuation = lang === 'powershell' ? /`\s*\n\s*/g : /\\\s*\n\s*/g;
  const joined = block.replace(continuation, ' ');

  return joined.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function errorsForCommand(commandLine: string): InvocationError[] {
  const normalized = commandLine.replace(/["']/g, '');
  const match = normalized.match(/(?:^|\s)mndw\s+(\S+)(.*)$/);

  if (match === null) {
    return [];
  }

  const commandName = match[1] ?? '';
  const args = match[2] ?? '';
  const command = commandTree.commands.find((item) => item.name() === commandName);

  if (command === undefined) {
    return [{command: commandName}];
  }

  const options = optionsFor(commandName);
  const flags = args.match(/--[\w-]+(?:=[^\s]+)?/g) ?? [];

  return flags
    .map((flag) => flag.split('=', 1)[0] ?? flag)
    .filter((flag) => flag !== '--help' && !options.has(flag))
    .map((flag) => ({command: commandName, flag}));
}

function errorsForBlocks(blocks: Array<{lang: string; code: string}>): InvocationError[] {
  return blocks
    .filter((block) => ['sh', 'bash', 'powershell'].includes(block.lang))
    .flatMap((block) => shellCommands(block.code, block.lang))
    .flatMap(errorsForCommand);
}

const fixture = (lang: string, code: string): Array<{lang: string; code: string}> => [{lang, code}];

describe('documented CLI flags', () => {
  it('rejects the hidden host-device alias', () => {
    expect(errorsForBlocks(fixture('bash', 'npx mndw dev demo --host-device http://x'))).toContainEqual({
      command: 'dev',
      flag: '--host-device',
    });
  });

  it('accepts a continued bash command and names an unknown flag', () => {
    expect(errorsForBlocks(fixture('bash', 'npx mndw dev demo \\\n  --ui-port 5180'))).toEqual([]);
    expect(errorsForBlocks(fixture('bash', 'npx mndw dev demo \\\n  --ui-prot 5180'))).toContainEqual({
      command: 'dev',
      flag: '--ui-prot',
    });
  });

  it('accepts a continued PowerShell command and names an unknown flag', () => {
    expect(errorsForBlocks(fixture('powershell', 'npx mndw dev demo `\n  --ui-port 5180'))).toEqual([]);
    expect(errorsForBlocks(fixture('powershell', 'npx mndw dev demo `\n  --ui-prot 5180'))).toContainEqual({
      command: 'dev',
      flag: '--ui-prot',
    });
  });

  it('checks shell blocks from non-pending pages', () => {
    const errors: string[] = [];

    for (const page of authorDocPages(repoRoot)) {
      const markdown = readFileSync(resolve(repoRoot, page), 'utf8');
      const blocks = readFencedBlocks(page, markdown);

      for (const error of errorsForBlocks(blocks)) {
        errors.push(`${page}: ${error.command} ${error.flag ?? ''}`.trim());
      }
    }

    expect(errors).toEqual([]);
  });
});
