import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import postcss, {type AtRule, type Node, type Rule} from 'postcss';

import {readPluginPackage} from './plugin-package.js';

const isKeyframesRule = (name: string): boolean => {
  return /^(?:-\w+-)?keyframes$/i.test(name);
};

const isAtRule = (node: Node): node is AtRule => {
  return node.type === 'atrule';
};

const hasKeyframesAncestor = (rule: Rule): boolean => {
  let node: Node | undefined = rule.parent;

  while (node !== undefined) {
    if (isAtRule(node) && isKeyframesRule(node.name)) {
      return true;
    }

    node = node.parent;
  }

  return false;
};

const isRootTokenSelector = (selector: string): boolean => {
  return /^:root(?:\[data-theme(?:=(?:"[^"]*"|'[^']*'|[^\]]+))?\])*$/.test(selector);
};

const skipCssEscape = (selector: string, index: number): number => {
  let next = index + 1;

  if (!/[\da-f]/i.test(selector[next] ?? '')) {
    return Math.min(next + 1, selector.length);
  }

  for (let digits = 0; digits < 6 && /[\da-f]/i.test(selector[next] ?? ''); digits++) {
    next++;
  }

  return next + (/[\s]/.test(selector[next] ?? '') ? 1 : 0);
};

const firstRootCombinator = (selector: string, start: number): string | undefined => {
  let brackets = 0;
  let parentheses = 0;
  let quote: string | undefined;

  for (let index = start; index < selector.length; index++) {
    const character = selector[index];

    if (character === '\\') {
      index = skipCssEscape(selector, index) - 1;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (selector.startsWith('/*', index)) {
      const commentEnd = selector.indexOf('*/', index + 2);

      if (commentEnd === -1) {
        return undefined;
      }

      index = commentEnd + 1;
      continue;
    }

    if (character === '"' || character === '\'') {
      quote = character;
      continue;
    }

    if (character === '[') {
      brackets++;
      continue;
    }

    if (character === ']' && brackets > 0) {
      brackets--;
      continue;
    }

    if (character === '(') {
      parentheses++;
      continue;
    }

    if (character === ')' && parentheses > 0) {
      parentheses--;
      continue;
    }

    if (brackets > 0 || parentheses > 0) {
      continue;
    }

    if (character !== undefined && '+~>'.includes(character)) {
      return character;
    }

    if (character !== undefined && /\s/.test(character)) {
      const next = selector.slice(index).replace(/^(?:\s+|\/\*[\s\S]*?\*\/)+/, '')[0];

      return next !== undefined && '+~>'.includes(next) ? next : ' ';
    }
  }

  return undefined;
};

const isPluginScoped = (selector: string, pluginName: string): boolean => {
  const prefix = `.${pluginName}`;

  if (!selector.startsWith(prefix)) {
    return false;
  }

  const boundary = selector[prefix.length];

  if (
    boundary !== undefined
    && !'.#:['.includes(boundary)
    && !/\s/.test(boundary)
    && !'><+~'.includes(boundary)
  ) {
    return false;
  }

  const combinator = firstRootCombinator(selector, prefix.length);

  return combinator !== '+' && combinator !== '~';
};

/** Finds style selectors outside plugin scope, while ignoring declarations and keyframe steps. */
export function findUnscopedCssSelectors(
  css: string,
  pluginName: string,
  allowlist: readonly string[] = [],
): string[] {
  const ignored = new Set(allowlist);
  const violations: string[] = [];

  postcss.parse(css).walkRules((rule) => {
    if (hasKeyframesAncestor(rule)) {
      return;
    }

    for (const selector of rule.selectors) {
      if (!ignored.has(selector) && !isRootTokenSelector(selector) && !isPluginScoped(selector, pluginName)) {
        violations.push(selector);
      }
    }
  });

  return violations;
}

/** Reads the packed CSS and returns validation warnings without making CSS scope an error. */
export function validatePluginCss(pluginDir: string, pluginName: string): string[] {
  const cssPath = join(pluginDir, 'dist', 'index.css');

  if (!existsSync(cssPath)) {
    return [];
  }

  const css = readFileSync(cssPath, 'utf8');
  const packageMetadata = readPluginPackage(pluginDir);
  const configuredAllowlist = packageMetadata?.mndw?.cssSelectorAllowlist;
  const allowlist = Array.isArray(configuredAllowlist)
    ? configuredAllowlist.filter((selector): selector is string => typeof selector === 'string')
    : [];

  return findUnscopedCssSelectors(css, pluginName, allowlist)
    .map((selector) => `CSS selector "${selector}" is not scoped under .${pluginName}`);
}
