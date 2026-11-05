import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/plugin-author-docs.yml'), 'utf8');

function indentedSection(parent: string, key: string): string {
  const lines = parent.split('\n');
  const start = lines.findIndex((line) => line === `  ${key}:`);

  if (start < 0) {
    return '';
  }

  let end = start + 1;

  while (end < lines.length && !/^ {2}\S|^\S/.test(lines[end] ?? '')) {
    end += 1;
  }

  return lines.slice(start, end).join('\n');
}

function triggerSection(key: 'pull_request' | 'push'): string {
  const onSection = workflow.split(/^on:\s*$/m)[1] ?? '';

  return indentedSection(onSection, key);
}

const requiredPaths = [
  'frontend/sdk/src/**',
  'frontend/sdk/package.json',
  'frontend/sdk/tsconfig.json',
  'frontend/ui/src/**',
  'frontend/ui-*/src/**',
  'tooling/cli/src/**',
  'tooling/cli/templates/**',
  'tooling/cli/package.json',
  'plugins/examples/hello-widget/**',
  'plugins/examples/rci-device-name-widget/**',
  'build/docs/**',
  'build/docs-snippet-env/**',
  'README.md',
  'frontend/sdk/README.md',
  'tooling/cli/README.md',
  'tsconfig.base.json',
  'frontend/ui/package.json',
  'frontend/ui-*/package.json',
  'frontend/ui-angular/tsconfig.json',
  'tooling/palette-core/src/**',
  'tooling/palette-core/package.json',
  'docs/plugin-author/**',
  '.github/workflows/plugin-author-docs.yml',
  'package.json',
  'pnpm-lock.yaml',
];

describe('plugin author docs workflow', () => {
  it('pushes and deploys from master', () => {
    const push = triggerSection('push');
    const branchConditions = workflow.match(/refs\/heads\/(?:main|master)/g) ?? [];

    expect(push).toMatch(/^ {4}branches:\n {6}- ['"]?master['"]?$/m);
    expect(push).not.toContain('- main');
    expect(branchConditions).toEqual(['refs/heads/master', 'refs/heads/master']);
  });

  it('runs docs checks before building the site', () => {
    const build = indentedSection(workflow.split(/^jobs:\s*$/m)[1] ?? '', 'build');
    const checkIndex = build.indexOf('run: pnpm test:docs');
    const buildIndex = build.indexOf('run: pnpm docs:build');

    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(checkIndex);
  });

  it('triggers both pull requests and pushes for every checked input', () => {
    for (const trigger of ['pull_request', 'push'] as const) {
      const section = triggerSection(trigger);

      for (const path of requiredPaths) {
        expect(section, `${trigger} paths include ${path}`).toContain(`- '${path}'`);
      }
    }
  });
});
