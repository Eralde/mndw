import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {auditPx} from './audit-px.mjs';

const temporaryDirectories: string[] = [];

const makeFixture = async (contents: string, relativePath = 'fixture.css'): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'mndw-px-audit-'));

  temporaryDirectories.push(root);

  const file = join(root, relativePath);

  await mkdir(join(file, '..'), {recursive: true});
  await writeFile(file, contents, 'utf8');

  return root;
};

afterEach(async () => {
  const {rm} = await import('node:fs/promises');

  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

describe('auditPx', () => {
  it.each([
    ['padding: 8px', false],
    ['outline-offset: 2px', false],
    ['outline-offset: -2px', false],
    ['border: 1px solid red', true],
    ['box-shadow: 0 8px 24px black', true],
    ['filter: drop-shadow(0 0 4px red)', true],
    ['@media (max-width: 720px)', true],
    ['@container card (max-width: 420px)', true],
    ['width: min(80vw, 280px)', true],
    ['width: calc(var(--size) - 8px)', false],
    ['style.padding = `${padding}px`', false],
  ])('classifies %s as %s', async (source, allowed) => {
    const root = await makeFixture(source);
    const result = auditPx({roots: [root]});

    expect(result.violations.length === 0).toBe(allowed);
  });

  it('strips comments without treating comment markers inside strings as comments', async () => {
    const root = await makeFixture(
      `
      /* padding: 8px */
      // margin: 4px
      <!-- width: 2px -->
      const value = "// keep 3px";
      const css = 'padding: 6px';
    `,
      'fixture.ts',
    );

    const result = auditPx({roots: [root]});

    expect(result.violations).toHaveLength(2);
    expect(result.violations.map(({line}) => line)).toEqual([5, 6]);
  });

  it('matches digit-bearing custom properties and ignores identifier text', async () => {
    const root = await makeFixture(`
      :root { --mndw-space-1: 4px; --shadow1: 1px; }
      const identifier = 'udpxy';
    `);

    const result = auditPx({roots: [root]});

    expect(result.violations).toHaveLength(2);
  });

  it('allows known runtime geometry forms only at their allowlisted paths', async () => {
    const root = await makeFixture(
      'const style = `left: ${anchor.left}px; top: ${anchor.top}px;`',
      'frontend/ui/src/charts/chart-frame.ts',
    );
    const result = auditPx({roots: [root]});

    expect(result.violations).toEqual([]);

    const unexpectedRoot = await makeFixture('const style = `${value}px`;', 'frontend/ui/src/charts/chart-frame.ts');
    const unexpected = auditPx({roots: [unexpectedRoot]});

    expect(unexpected.violations).toHaveLength(1);
  });

  it('allows translateY(0px) only in scroll-area runtime code and allows breakpoint concatenation', async () => {
    const root = await makeFixture(
      'thumb.style.transform = \'translateY(0px)\';',
      'frontend/ui/src/scroll-area/scroll-area.ts',
    );
    const breakpointRoot = await makeFixture(
      'const query = \'(max-width: \' + MOBILE_BREAKPOINT_PX + \'px)\';',
      'frontend/host/src/layout/breakpoint.ts',
    );

    expect(auditPx({roots: [root]}).violations).toEqual([]);
    expect(auditPx({roots: [breakpointRoot]}).violations).toEqual([]);
  });

  it('excludes test files and end-to-end fixtures', async () => {
    const root = await makeFixture('padding: 8px', 'component.test.ts');
    const fixtureRoot = await makeFixture('padding: 8px', 'frontend/ui/e2e/fixtures/component.ts');

    expect(auditPx({roots: [root]}).violations).toEqual([]);
    expect(auditPx({roots: [fixtureRoot]}).violations).toEqual([]);
  });
});
