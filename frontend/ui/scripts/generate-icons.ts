import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {type IconSource, buildIconAssets} from './icon-sprite';

export interface IconCliOptions {
  sourceDir: string;
  outputDir: string;
  check: boolean;
}

export interface IconInventory {
  missing: string[];
  extra: string[];
}

export interface IconGenerationResult extends IconInventory {
  status: 'ok' | 'inventory-mismatch' | 'stale';
  stale: string[];
  written: string[];
}

export interface UpstreamSelection {
  release: string;
  names: string[];
  licenseFile: string;
}

const SPRITE_FILE = 'sprite.svg';
const NAMES_FILE = 'names.ts';
const UPSTREAM_FILE = 'UPSTREAM.json';

export function inspectIconInventory(sourceDir: string): IconInventory {
  const selection = readSelection(sourceDir);
  return compareInventory(selection.names, readSvgFiles(sourceDir));
}

export function runIconGeneration(options: IconCliOptions): IconGenerationResult {
  const selection = readSelection(options.sourceDir);
  const inventory = compareInventory(selection.names, readSvgFiles(options.sourceDir));

  if (inventory.missing.length > 0 || inventory.extra.length > 0) {
    return {...inventory, status: 'inventory-mismatch', stale: [], written: []};
  }

  const sources: IconSource[] = selection.names.map((name) => {
    return {name, svg: readFileSync(join(options.sourceDir, `${name}.svg`), 'utf8')};
  });
  const license = readFileSync(join(options.sourceDir, selection.licenseFile), 'utf8');
  const assets = buildIconAssets(sources, license);
  const outputs: [string, string][] = [
    [SPRITE_FILE, assets.sprite],
    [NAMES_FILE, assets.names],
  ];

  const stale: string[] = [];
  for (const [file, contents] of outputs) {
    if (readOutput(join(options.outputDir, file)) !== contents) {
      stale.push(file);
    }
  }

  if (options.check) {
    return {...inventory, status: stale.length > 0 ? 'stale' : 'ok', stale, written: []};
  }

  mkdirSync(options.outputDir, {recursive: true});

  const written: string[] = [];
  for (const [file, contents] of outputs) {
    if (!stale.includes(file)) {
      continue;
    }
    writeFileSync(join(options.outputDir, file), contents);
    written.push(file);
  }

  return {...inventory, status: 'ok', stale, written};
}

export function formatDiagnostics(result: IconGenerationResult): string[] {
  const diagnostics: string[] = [];
  if (result.missing.length > 0) {
    diagnostics.push(`Missing SVGs: ${result.missing.join(', ')}`);
  }
  if (result.extra.length > 0) {
    diagnostics.push(`Extra SVGs: ${result.extra.join(', ')}`);
  }
  if (result.status === 'stale') {
    diagnostics.push(`Stale generated files: ${result.stale.join(', ')}`);
  }
  return diagnostics;
}

export function main(argv: readonly string[]): number {
  const options = parseOptions(argv);
  const result = runIconGeneration(options);
  const diagnostics = formatDiagnostics(result);

  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      console.error(diagnostic);
    }
    return 1;
  }

  if (result.written.length > 0) {
    console.log(`Generated: ${result.written.join(', ')}`);
  }
  return 0;
}

function parseOptions(argv: readonly string[]): IconCliOptions {
  let sourceDir: string | null = null;
  let outputDir: string | null = null;
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--source-dir' || arg === '--output-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a path.`);
      }
      if (arg === '--source-dir') {
        sourceDir = resolve(value);
      } else {
        outputDir = resolve(value);
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument "${arg}".`);
  }

  const defaults = defaultPaths();
  return {
    sourceDir: sourceDir ?? defaults.sourceDir,
    outputDir: outputDir ?? defaults.outputDir,
    check,
  };
}

function defaultPaths(): {sourceDir: string; outputDir: string} {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  return {
    sourceDir: join(scriptsDir, '..', 'icons', 'lucide'),
    outputDir: join(scriptsDir, '..', 'src', 'icon', 'generated'),
  };
}

function readSelection(sourceDir: string): UpstreamSelection {
  const raw = JSON.parse(readFileSync(join(sourceDir, UPSTREAM_FILE), 'utf8')) as Partial<UpstreamSelection>;
  const names = raw.names;
  if (!raw.release || !Array.isArray(names) || names.length === 0) {
    throw new Error(`${UPSTREAM_FILE} must declare "release" and a non-empty "names" array.`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`${UPSTREAM_FILE} declares duplicate icon names.`);
  }
  return {release: raw.release, names: [...names], licenseFile: raw.licenseFile ?? 'LICENSE'};
}

function readSvgFiles(sourceDir: string): string[] {
  return readdirSync(sourceDir).filter((file) => file.endsWith('.svg')).sort();
}

function compareInventory(names: readonly string[], files: readonly string[]): IconInventory {
  const present = new Set(files.map((file) => file.slice(0, -'.svg'.length)));
  const declared = new Set(names);
  return {
    missing: [...declared].filter((name) => !present.has(name)).map((name) => `${name}.svg`).sort(),
    extra: files.filter((file) => !declared.has(file.slice(0, -'.svg'.length))).sort(),
  };
}

function readOutput(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
