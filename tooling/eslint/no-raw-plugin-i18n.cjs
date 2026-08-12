'use strict';

const FORBIDDEN_METHODS = new Set(['t', 'formatNumber', 'formatDate']);

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require reactive Translator helpers instead of raw PluginI18n calls',
    },
    schema: [],
    messages: {
      rawPluginI18n: 'Use a reactive Translator instead of raw PluginI18n{{method}}',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (filename.endsWith('/render.ts') || filename.endsWith('/mws-page/src/mws-map-instance.ts')) {
      return {};
    }

    const parserServices = context.sourceCode.parserServices;
    const checker = parserServices.program?.getTypeChecker();
    const forbiddenVariables = new WeakSet();

    if (!checker || !parserServices.esTreeNodeToTSNodeMap) {
      return {};
    }

    const getType = (node) => {
      const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node);
      return tsNode === undefined ? undefined : checker.getTypeAtLocation(tsNode);
    };

    const isPluginI18nType = (node) => {
      const type = getType(node);
      if (type === undefined) {
        return false;
      }

      const symbol = type.aliasSymbol ?? type.symbol;
      return symbol?.name === 'PluginI18n';
    };

    const memberName = (node) => {
      if (node.computed || node.property.type !== 'Identifier') {
        return undefined;
      }

      return node.property.name;
    };

    const reportMember = (node, method) => {
      context.report({
        node,
        messageId: 'rawPluginI18n',
        data: {method: `.${method}()`},
      });
    };

    const findVariable = (scope, name) => {
      let current = scope;
      while (current !== null) {
        const variable = current.set.get(name);
        if (variable !== undefined) {
          return variable;
        }

        current = current.upper;
      }

      return undefined;
    };

    const markDestructuredMethods = (pattern, init) => {
      if (pattern.type !== 'ObjectPattern' || !isPluginI18nType(init)) {
        return;
      }

      for (const property of pattern.properties) {
        if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier') {
          continue;
        }

        if (!FORBIDDEN_METHODS.has(property.key.name) || property.value.type !== 'Identifier') {
          continue;
        }

        const variable = findVariable(context.sourceCode.getScope(property.value), property.value.name);
        if (variable !== undefined) {
          forbiddenVariables.add(variable);
        }
      }
    };

    return {
      VariableDeclarator(node) {
        if (node.init === null) {
          return;
        }

        markDestructuredMethods(node.id, node.init);

        if (node.id.type !== 'Identifier' || node.init.type !== 'MemberExpression') {
          return;
        }

        const method = memberName(node.init);
        if (method === undefined || !FORBIDDEN_METHODS.has(method) || !isPluginI18nType(node.init.object)) {
          return;
        }

        const variable = findVariable(context.sourceCode.getScope(node.id), node.id.name);
        if (variable !== undefined) {
          forbiddenVariables.add(variable);
        }
      },

      CallExpression(node) {
        if (node.callee.type === 'MemberExpression') {
          const method = memberName(node.callee);
          if (method !== undefined && FORBIDDEN_METHODS.has(method) && isPluginI18nType(node.callee.object)) {
            reportMember(node.callee, method);
          }
          return;
        }

        if (node.callee.type !== 'Identifier') {
          return;
        }

        const variable = findVariable(context.sourceCode.getScope(node), node.callee.name);
        if (variable !== undefined && forbiddenVariables.has(variable)) {
          context.report({
            node: node.callee,
            messageId: 'rawPluginI18n',
            data: {method: '()'},
          });
        }
      },
    };
  },
};
