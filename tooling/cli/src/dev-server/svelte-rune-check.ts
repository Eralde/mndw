import {parseAst} from 'vite';

const RUNE_NAMES = new Set(['$state', '$derived', '$effect', '$props']);

interface AstNode {
  readonly type?: string;
  readonly callee?: AstNode;
  readonly name?: string;
  readonly [key: string]: unknown;
}

function hasUncompiledRuneCall(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasUncompiledRuneCall);
  }

  if (typeof node !== 'object' || node === null) {
    return false;
  }

  const astNode = node as AstNode;

  if (
    astNode.type === 'CallExpression' && astNode.callee?.type === 'Identifier'
    && astNode.callee.name !== undefined && RUNE_NAMES.has(astNode.callee.name)
  ) {
    return true;
  }

  return Object.values(astNode).some(hasUncompiledRuneCall);
}

/** True only for executable Svelte rune calls, ignoring occurrences in comments and string literals. */
export function containsUncompiledSvelteRuneCall(source: string): boolean {
  return hasUncompiledRuneCall(parseAst(source));
}
