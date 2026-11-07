import {readFile, readdir} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {deriveControlHover} from '@mndw/palette-core';
import {MNDW_TOKENS} from './tokens.js';
import {
  PALETTE_CONTRAST_PAIRS,
  PALETTE_CSS_VARIABLES,
  type PaletteTokenMap,
  contrastRatio,
  paletteToCss,
  validateImportedPalette,
} from './palette.js';

const TOKEN_NAMES = [
  'bg',
  'surface',
  'surfaceRaised',
  'border',
  'textSubtle',
  'textMuted',
  'text',
  'accent',
  'accentHover',
  'accentContrast',
  'danger',
  'dangerBg',
  'success',
  'successBg',
  'warning',
  'warningBg',
  'info',
  'infoBg',
  'focusRing',
  'surfaceHover',
  'controlHover',
  'shadowColor',
] as const;

/** A structurally valid, contrast-clean palette: white-on-black dark, black-on-white light. */
function validMap(): PaletteTokenMap {
  const dark = Object.fromEntries(TOKEN_NAMES.map((t) => [t, '#ffffff'])) as Record<string, string>;
  const light = Object.fromEntries(TOKEN_NAMES.map((t) => [t, '#000000'])) as Record<string, string>;

  dark.bg = '#000000';
  dark.surface = '#000000';
  dark.surfaceRaised = '#000000';
  dark.surfaceHover = '#000000';
  dark.controlHover = '#000000';
  dark.accent = '#000000';
  dark.dangerBg = '#000000';
  dark.successBg = '#000000';
  dark.warningBg = '#000000';
  dark.infoBg = '#000000';
  light.bg = '#ffffff';
  light.surface = '#ffffff';
  light.surfaceRaised = '#ffffff';
  light.surfaceHover = '#ffffff';
  light.controlHover = '#ffffff';
  light.accent = '#ffffff';
  light.dangerBg = '#ffffff';
  light.successBg = '#ffffff';
  light.warningBg = '#ffffff';
  light.infoBg = '#ffffff';

  return {dark, light} as PaletteTokenMap;
}

describe('metadata', () => {
  it('lists all 22 tokens in canonical order with kebab-case css vars', () => {
    expect(PALETTE_CSS_VARIABLES.map((entry) => entry.token)).toEqual([...TOKEN_NAMES]);
    expect(PALETTE_CSS_VARIABLES.map((entry) => entry.cssVar)).toEqual([
      '--mndw-bg',
      '--mndw-surface',
      '--mndw-surface-raised',
      '--mndw-border',
      '--mndw-text-subtle',
      '--mndw-text-muted',
      '--mndw-text',
      '--mndw-accent',
      '--mndw-accent-hover',
      '--mndw-accent-contrast',
      '--mndw-danger',
      '--mndw-danger-bg',
      '--mndw-success',
      '--mndw-success-bg',
      '--mndw-warning',
      '--mndw-warning-bg',
      '--mndw-info',
      '--mndw-info-bg',
      '--mndw-focus-ring',
      '--mndw-surface-hover',
      '--mndw-control-hover',
      '--mndw-shadow-color',
    ]);
  });

  it('declares all 17 audited contrast pairs', () => {
    expect(PALETTE_CONTRAST_PAIRS).toHaveLength(17);
    expect(PALETTE_CONTRAST_PAIRS[0]).toEqual({fg: 'text', bg: 'surface', min: 4.5});
  });
});

describe('contrastRatio', () => {
  it('returns 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#016ca5', '#016ca5')).toBeCloseTo(1, 5);
  });

  it('accepts 3-digit shorthand equivalently to 6-digit', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(contrastRatio('#ffffff', '#000000'), 10);
  });

  it('ignores the alpha channel of an 8-digit value', () => {
    expect(contrastRatio('#ffffff80', '#000000')).toBeCloseTo(21, 5);
  });
});

describe('validateImportedPalette structural rules', () => {
  it('accepts a well-formed map with no warnings', () => {
    const result = validateImportedPalette(validMap());

    expect(result.structuralErrors).toEqual([]);
    expect(result.contrastWarnings).toEqual([]);
    expect(result.palette).not.toBeNull();
  });

  it('accepts a legacy palette without controlHover and derives it from each surface', () => {
    const map = validMap() as unknown as Record<string, Record<string, string>>;

    delete map.dark.controlHover;
    delete map.light.controlHover;

    const result = validateImportedPalette(map);

    expect(result.structuralErrors).toEqual([]);
    expect(result.palette?.dark.controlHover).toBe(deriveControlHover(map.dark.surface, map.dark.text, 'dark'));
    expect(result.palette?.light.controlHover).toBe(deriveControlHover(map.light.surface, map.light.text, 'light'));
    expect(result.palette?.dark.controlHover).not.toBe(map.dark.surface);
    expect(result.palette?.light.controlHover).not.toBe(map.light.surface);
    expect(contrastRatio(result.palette?.dark.text ?? '', result.palette?.dark.controlHover ?? ''))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.palette?.light.text ?? '', result.palette?.light.controlHover ?? ''))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('accepts 3-, 6- and 8-digit hex and preserves the value verbatim', () => {
    const map = validMap();

    map.dark.warning = '#abc';
    map.light.warning = '#AABBCCDD';

    const result = validateImportedPalette(map);

    expect(result.structuralErrors).toEqual([]);
    expect(result.palette?.dark.warning).toBe('#abc');
    expect(result.palette?.light.warning).toBe('#AABBCCDD');
  });

  it.each([
    ['a missing theme', (map: PaletteTokenMap) => delete (map as Record<string, unknown>).light],
    [
      'an extra top-level key',
      (map: PaletteTokenMap) => {
        (map as Record<string, unknown>).sepia = {};
      },
    ],
    ['a missing token', (map: PaletteTokenMap) => delete (map.dark as Record<string, unknown>).accent],
    [
      'an extra token',
      (map: PaletteTokenMap) => {
        (map.dark as Record<string, unknown>).accentQuiet = '#fff';
      },
    ],
    [
      'a non-string value',
      (map: PaletteTokenMap) => {
        (map.dark as Record<string, unknown>).accent = 42;
      },
    ],
    [
      'a non-hex string',
      (map: PaletteTokenMap) => {
        map.dark.accent = 'rebeccapurple';
      },
    ],
    [
      'a hex of the wrong length',
      (map: PaletteTokenMap) => {
        map.dark.accent = '#12345';
      },
    ],
    [
      'a hex missing its hash',
      (map: PaletteTokenMap) => {
        map.dark.accent = 'ffffff';
      },
    ],
  ])('rejects %s with palette null and at least one error', (_label, mutate) => {
    const map = validMap();

    mutate(map);

    const result = validateImportedPalette(map);

    expect(result.palette).toBeNull();
    expect(result.structuralErrors.length).toBeGreaterThan(0);
    expect(result.contrastWarnings).toEqual([]);
  });

  it('rejects a legacy 14-token palette', () => {
    const map = validMap() as unknown as Record<string, Record<string, string>>;

    for (const theme of ['dark', 'light']) {
      for (
        const token of [
          'successBg',
          'warningBg',
          'info',
          'infoBg',
          'focusRing',
          'surfaceHover',
          'controlHover',
          'shadowColor',
        ]
      ) {
        delete map[theme][token];
      }
    }

    const result = validateImportedPalette(map);

    expect(result.palette).toBeNull();
    expect(result.structuralErrors).toHaveLength(14);
  });

  it.each([[null], [undefined], ['a string'], [42], [[]]])('rejects the non-object input %p', (input) => {
    expect(validateImportedPalette(input).palette).toBeNull();
  });
});

describe('validateImportedPalette contrast warnings', () => {
  it('returns the palette and reports only failing pairs, attributed per theme', () => {
    const map = validMap();

    // Break `text` in both themes. Note this trips TWO pairs per theme:
    // validMap sets bg === surface, so `text on surface` and `text on bg` both fail,
    // giving four warnings total. The filter below isolates the pair under test —
    // seeing four warnings here is correct, not a validation bug.
    map.dark.text = '#010101';
    map.light.text = '#fefefe';

    const result = validateImportedPalette(map);

    expect(result.palette).not.toBeNull();
    expect(result.structuralErrors).toEqual([]);

    const failing = result.contrastWarnings.filter((w) => w.pair === 'text on surface');

    expect(failing).toHaveLength(2);
    expect(failing.map((w) => w.theme)).toEqual(['dark', 'light']);
    expect(failing[0].min).toBe(4.5);
    expect(failing[0].ratio).toBeLessThan(4.5);
    // Ratios are rounded to 2 decimals.
    expect(failing[0].ratio).toBe(Number(failing[0].ratio.toFixed(2)));
  });

  it('emits warnings dark-first then light', () => {
    const map = validMap();

    // textMuted and textSubtle each appear in two surface pairs, so breaking them
    // produces a predictable warning count.
    map.dark.textMuted = map.dark.surface;
    map.dark.textSubtle = map.dark.surface;
    map.light.textMuted = map.light.surface;

    const themes = validateImportedPalette(map).contrastWarnings.map((w) => w.theme);

    expect(themes).toEqual(['dark', 'dark', 'dark', 'dark', 'light', 'light']);
  });
});

describe('shipped default palette', () => {
  it('imports cleanly with zero contrast warnings', () => {
    const result = validateImportedPalette(JSON.parse(JSON.stringify(MNDW_TOKENS)));

    expect(result.structuralErrors).toEqual([]);
    expect(result.contrastWarnings).toEqual([]);
  });

  it.each(
    [
      ['dark', 'danger', 'dangerBg', 4.55],
      ['dark', 'border', 'surface', 3.26],
      ['light', 'border', 'surface', 3.23],
      ['dark', 'text', 'surface', 17.12],
      ['light', 'text', 'surface', 16.69],
      ['dark', 'accentContrast', 'accent', 5.69],
    ] as const,
  )('%s %s on %s is %f', (theme, fg, bg, expected) => {
    const ratio = contrastRatio(MNDW_TOKENS[theme][fg], MNDW_TOKENS[theme][bg]);

    expect(Number(ratio.toFixed(2))).toBe(expected);
  });
});

describe('paletteToCss', () => {
  it('renders both blocks with :root by default, in canonical token order', () => {
    const map = validMap();

    map.dark.bg = '#010203';
    map.light.bg = '#f0f1f2';

    const css = paletteToCss(map);

    expect(css).toContain(':root,\n:root[data-theme=\'dark\'] {\n  --mndw-bg: #010203;\n');
    expect(css).toContain(':root[data-theme=\'light\'] {\n  --mndw-bg: #f0f1f2;\n');
    expect(css.indexOf('--mndw-surface-raised')).toBeGreaterThan(css.indexOf('--mndw-surface:'));
    expect(css.startsWith(':root,')).toBe(true);
  });

  it('applies a custom selector to every rule', () => {
    const css = paletteToCss(validMap(), {selector: ':root:root'});

    expect(css).toContain(':root:root,\n:root:root[data-theme=\'dark\'] {');
    expect(css).toContain(':root:root[data-theme=\'light\'] {');
    expect(css).not.toContain('\n:root[');
  });

  it('is deterministic', () => {
    expect(paletteToCss(validMap())).toBe(paletteToCss(validMap()));
  });
});

describe('module independence', () => {
  it('does not import the generated tokens file', async () => {
    const source = await readFile(new URL('./palette.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/(?:from|import)\s+['"]\.\/tokens(?:\.js|\.ts)['"]/);
  });
});

describe('shared fixture corpus', () => {
  it('accepts every valid fixture and rejects every invalid fixture', async () => {
    const fixtures = new URL('../fixtures/palettes/', import.meta.url);

    for (const kind of ['valid', 'invalid'] as const) {
      const names = (await readdir(new URL(`${kind}/`, fixtures))).filter((name) => name.endsWith('.json')).sort();

      expect(names.length).toBeGreaterThan(0);

      for (const name of names) {
        const input: unknown = JSON.parse(await readFile(new URL(`${kind}/${name}`, fixtures), 'utf8'));
        const result = validateImportedPalette(input);

        if (kind === 'valid') {
          expect(result.structuralErrors, `${kind}/${name}`).toEqual([]);
          expect(result.palette, `${kind}/${name}`).not.toBeNull();
          expect(result.palette?.dark.controlHover, `${kind}/${name} dark controlHover`).toMatch(/^#[0-9a-f]{6}$/i);
          expect(result.palette?.light.controlHover, `${kind}/${name} light controlHover`).toMatch(/^#[0-9a-f]{6}$/i);
        } else {
          expect(result.structuralErrors, `${kind}/${name}`).not.toEqual([]);
          expect(result.palette, `${kind}/${name}`).toBeNull();
        }
      }
    }
  });
});
