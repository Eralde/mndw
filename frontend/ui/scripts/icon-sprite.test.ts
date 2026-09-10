import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {inspectIconInventory, main} from './generate-icons';
import {type IconSource, buildIconAssets} from './icon-sprite';

const LICENSE = 'ISC License\nCopyright (c) Lucide & Contributors <ok>';

function source(name: string, body: string, rootAttrs = ''): IconSource {
  const attrs = rootAttrs
    || 'width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return {
    name,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`,
  };
}

const eye: IconSource = source('eye', '<path d="M1 1h2"/>');
const x: IconSource = source('x', '<path d="M1 1l2 2"/>');

describe('buildIconAssets', () => {
  it('is independent of input order', () => {
    expect(buildIconAssets([eye, x], LICENSE).sprite).toBe(buildIconAssets([x, eye], LICENSE).sprite);
  });

  it('derives the catalog from the same validated set', () => {
    const forward = buildIconAssets([eye, x], LICENSE).names;
    const reverse = buildIconAssets([x, eye], LICENSE).names;
    expect(forward).toBe(reverse);
    expect(forward).toContain('\'eye\'');
    expect(forward).toContain('\'x\'');
    expect(forward.indexOf('\'eye\'')).toBeLessThan(forward.indexOf('\'x\''));
  });

  it('rejects duplicate names', () => {
    expect(() => buildIconAssets([eye, eye], LICENSE)).toThrow(/duplicate/i);
  });

  it('rejects invalid names', () => {
    for (const name of ['Eye', 'bad name', '../eye', 'eye.svg', '', '1eye']) {
      expect(() => buildIconAssets([source(name, '<path d="M1 1h2"/>')], LICENSE)).toThrow(/name/i);
    }
  });

  it('rejects malformed XML', () => {
    expect(() => buildIconAssets([{name: 'eye', svg: '<svg><path d="M1 1h2"></svg>'}], LICENSE)).toThrow(
      /malformed|well-formed|xml/i,
    );
    expect(() => buildIconAssets([{name: 'eye', svg: 'not xml at all'}], LICENSE)).toThrow(
      /malformed|well-formed|xml/i,
    );
    expect(() => buildIconAssets([{name: 'eye', svg: '<svg></svg><svg></svg>'}], LICENSE)).toThrow(
      /malformed|well-formed|xml|root/i,
    );
  });

  it('requires a 24x24 viewBox on a single SVG root', () => {
    expect(() =>
      buildIconAssets([
        {name: 'eye', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h2"/></svg>'},
      ], LICENSE)
    ).toThrow(/viewBox/i);
    expect(() =>
      buildIconAssets([
        {name: 'eye', svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1h2"/></svg>'},
      ], LICENSE)
    ).toThrow(/viewBox/i);
  });

  it('removes outer dimensions while retaining geometry and stroke attributes', () => {
    const {sprite} = buildIconAssets([eye], LICENSE);
    expect(sprite).not.toMatch(/ width="24"/);
    expect(sprite).not.toMatch(/ height="24"/);
    expect(sprite).toContain('viewBox="0 0 24 24"');
    expect(sprite).toContain('stroke="currentColor"');
    expect(sprite).toContain('stroke-width="2"');
    expect(sprite).toContain('stroke-linecap="round"');
    expect(sprite).toContain('fill="none"');
    expect(sprite).toContain('<path d="M1 1h2" />');
    expect(sprite).toContain('id="mndw-icon-eye"');
  });

  it('accepts all supported geometry and preserves presentation attributes', () => {
    const body = [
      '<path d="M1 1h2" fill-rule="evenodd"/>',
      '<line x1="1" y1="2" x2="3" y2="4"/>',
      '<polyline points="1,2 3,4"/>',
      '<polygon points="1,2 3,4"/>',
      '<circle cx="1" cy="2" r="3"/>',
      '<ellipse cx="1" cy="2" rx="3" ry="4"/>',
      '<rect x="1" y="2" width="3" height="4" rx="1"/>',
      '<g transform="translate(1 2)"><path d="M1 1h2" clip-rule="evenodd"/></g>',
    ].join('');
    const {sprite} = buildIconAssets([source('shapes', body)], LICENSE);
    expect(sprite).toContain('<path d="M1 1h2" fill-rule="evenodd" />');
    expect(sprite).toContain('<line x1="1" y1="2" x2="3" y2="4" />');
    expect(sprite).toContain('<polyline points="1,2 3,4" />');
    expect(sprite).toContain('<polygon points="1,2 3,4" />');
    expect(sprite).toContain('<circle cx="1" cy="2" r="3" />');
    expect(sprite).toContain('<ellipse cx="1" cy="2" rx="3" ry="4" />');
    expect(sprite).toContain('<rect x="1" y="2" width="3" height="4" rx="1" />');
    expect(sprite).toContain('<g transform="translate(1 2)">');
    expect(sprite).toContain('<path d="M1 1h2" clip-rule="evenodd" />');
    expect(sprite).toContain('</g>');
  });

  it('rejects scripts, foreign content, events, styles, ids, references and unsupported attributes', () => {
    const cases: [string, string][] = [
      ['script element', '<script></script>'],
      ['foreign content', '<div><path d="M1 1h2"/></div>'],
      ['event attribute', '<path d="M1 1h2" onclick="alert(1)"/>'],
      ['style attribute', '<path d="M1 1h2" style="fill:red"/>'],
      ['style element', '<style></style>'],
      ['nested id', '<path id="inner" d="M1 1h2"/>'],
      ['external reference', '<image href="https://example.com/a.png"/>'],
      ['use reference', '<use href="#other"/>'],
      ['unsupported element', '<text/>'],
      ['unsupported attribute', '<path d="M1 1h2" data-foo="1"/>'],
    ];
    for (const [label, body] of cases) {
      expect(() => buildIconAssets([source('eye', body)], LICENSE), label).toThrow(
        /reject|unsupported|not allowed|forbidden/i,
      );
    }
  });

  it('rejects root level risks and unexpected text content', () => {
    expect(() =>
      buildIconAssets([source('eye', '<path d="M1 1h2"/>', 'viewBox="0 0 24 24" onload="alert(1)"')], LICENSE)
    ).toThrow(
      /reject|unsupported|not allowed|forbidden/i,
    );
    expect(() => buildIconAssets([source('eye', 'M1 1h2')], LICENSE)).toThrow(/text|content/i);
  });

  it('carries the escaped license as sprite metadata', () => {
    const {sprite} = buildIconAssets([eye], LICENSE);
    expect(sprite).toContain('ISC License');
    expect(sprite).toContain('&amp;');
    expect(sprite).toContain('&lt;ok&gt;');
    expect(sprite).not.toContain('<ok>');
  });
});

interface TempFixture {
  readonly root: string;
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly cleanup: () => void;
}

function tempFixture(names: readonly string[], files: readonly string[]): TempFixture {
  const root = mkdtempSync(join(tmpdir(), 'mndw-icons-'));
  const sourceDir = join(root, 'icons');
  const outputDir = join(root, 'generated');
  mkdirSync(sourceDir);
  mkdirSync(outputDir);
  writeFileSync(join(sourceDir, 'LICENSE'), LICENSE);
  writeFileSync(join(sourceDir, 'UPSTREAM.json'), JSON.stringify({release: 'test', names}, null, 2));
  for (const file of files) {
    writeFileSync(
      join(sourceDir, file),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h2"/></svg>',
    );
  }
  return {
    root,
    sourceDir,
    outputDir,
    cleanup: () => rmSync(root, {recursive: true, force: true}),
  };
}

describe('icon CLI', () => {
  it('writes generated assets on exact parity', () => {
    const fixture = tempFixture(['eye', 'x'], ['eye.svg', 'x.svg']);
    try {
      expect(main(['--source-dir', fixture.sourceDir, '--output-dir', fixture.outputDir])).toBe(0);
      expect(readFileSync(join(fixture.outputDir, 'sprite.svg'), 'utf8')).toContain('mndw-icon-eye');
      expect(readFileSync(join(fixture.outputDir, 'names.ts'), 'utf8')).toContain('MNDW_ICON_NAMES');
    } finally {
      fixture.cleanup();
    }
  });

  it('reports missing and extra SVGs separately without writing', () => {
    const fixture = tempFixture(['eye', 'x'], ['x.svg', 'unexpected.svg']);
    try {
      const exitCode = main(['--source-dir', fixture.sourceDir, '--output-dir', fixture.outputDir]);
      expect(exitCode).not.toBe(0);
      expect(inspectIconInventory(fixture.sourceDir)).toEqual({missing: ['eye.svg'], extra: ['unexpected.svg']});
      expect(() => readFileSync(join(fixture.outputDir, 'sprite.svg'))).toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps previously generated bytes untouched on mismatch', () => {
    const fixture = tempFixture(['eye', 'x'], ['eye.svg', 'x.svg']);
    try {
      expect(main(['--source-dir', fixture.sourceDir, '--output-dir', fixture.outputDir])).toBe(0);
      const sprite = readFileSync(join(fixture.outputDir, 'sprite.svg'), 'utf8');
      writeFileSync(join(fixture.sourceDir, 'unexpected.svg'), '<svg/>');
      expect(main(['--source-dir', fixture.sourceDir, '--output-dir', fixture.outputDir])).not.toBe(0);
      expect(readFileSync(join(fixture.outputDir, 'sprite.svg'), 'utf8')).toBe(sprite);
    } finally {
      fixture.cleanup();
    }
  });

  it('checks committed output without writing', () => {
    const fixture = tempFixture(['eye'], ['eye.svg']);
    try {
      expect(main(['--source-dir', fixture.sourceDir, '--output-dir', fixture.outputDir])).toBe(0);
      expect(main(['--check', '--source-dir', fixture.sourceDir, '--output-dir', fixture.outputDir])).toBe(0);
      writeFileSync(join(fixture.outputDir, 'names.ts'), 'stale');
      expect(main(['--check', '--source-dir', fixture.sourceDir, '--output-dir', fixture.outputDir])).not.toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});
