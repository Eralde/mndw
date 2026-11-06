import {createReadStream} from 'node:fs';
import {builtinModules, isBuiltin} from 'node:module';
import {posix, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {extract} from 'tar-stream';
import ts from 'typescript';

export interface TarballProblem {
  kind:
    | 'missing-readme'
    | 'workspace-range'
    | 'ts-target'
    | 'missing-target'
    | 'non-executable-bin'
    | 'private'
    | 'undeclared-import';
  detail: string;
}

interface PackageMetadata {
  name?: unknown;
  private?: unknown;
  dependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
  exports?: unknown;
  main?: unknown;
  types?: unknown;
  bin?: unknown;
}

const dependencyFields = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;
const packageBuiltinNames = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/, '')));

const packageNameOf = (specifier: string): string | undefined => {
  if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) {
    return undefined;
  }

  const parts = specifier.split('/');

  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  }

  return parts[0] || undefined;
};

const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(stringsIn);
  }

  return [];
};

const isTypeScriptSource = (target: string): boolean => {
  return (target.endsWith('.ts') || target.endsWith('.tsx') || target.endsWith('.mts') || target.endsWith('.cts'))
    && !target.endsWith('.d.ts');
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
};

const targetExists = (target: string, entries: Map<string, Buffer>): boolean => {
  const normalizedTarget = posix.normalize(target.replace(/^\.\//, ''));

  if (normalizedTarget === '..' || normalizedTarget.startsWith('../') || normalizedTarget.startsWith('/')) {
    return false;
  }

  const pattern = new RegExp(`^package/${
    normalizedTarget.split('*').map(escapeRegExp)
      .join('.*')
  }$`);

  return [...entries.keys()].some((name) => pattern.test(name));
};

const findImports = (source: string): string[] => {
  const specifiers = new Set<string>();
  const sourceFile = ts.createSourceFile('package.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];

      if (argument !== undefined && ts.isStringLiteral(argument)) {
        specifiers.add(argument.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return [...specifiers];
};

interface TarballEntries {
  readonly contents: Map<string, Buffer>;
  readonly modes: Map<string, number>;
}

const readTarball = async (tarballPath: string): Promise<TarballEntries> => {
  const entries = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  const archive = extract();

  archive.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = [];

    stream.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else {
        next(new TypeError('Unexpected tar entry chunk type'));
      }
    });
    stream.on('end', () => {
      entries.set(header.name, Buffer.concat(chunks));
      modes.set(header.name, header.mode ?? 0);
      next();
    });
    stream.on('error', (error: Error) => {
      next(error);
    });
    stream.resume();
  });

  await pipeline(createReadStream(tarballPath), createGunzip(), archive);

  return {contents: entries, modes};
};

const hasExecutableMode = (mode: number): boolean => {
  const owner = Math.floor(mode / 0o100) % 0o10;
  const group = Math.floor(mode / 0o10) % 0o10;
  const other = mode % 0o10;

  return owner % 2 === 1 || group % 2 === 1 || other % 2 === 1;
};

const nonExecutableBinProblems = (bin: unknown, modes: Map<string, number>): TarballProblem[] => {
  return stringsIn(bin).flatMap((target) => {
    const normalizedTarget = posix.normalize(target.replace(/^\.\//, ''));
    const mode = modes.get(`package/${normalizedTarget}`);

    if (mode === undefined || hasExecutableMode(mode)) {
      return [];
    }

    return [{kind: 'non-executable-bin', detail: `Package bin target is not executable: ${target}`}];
  });
};

export const checkTarball = async (tgzPath: string): Promise<TarballProblem[]> => {
  const {contents: entries, modes} = await readTarball(tgzPath);
  const packageJson = entries.get('package/package.json');

  if (packageJson === undefined) {
    throw new Error(`Tarball is missing package/package.json: ${tgzPath}`);
  }

  const metadata = JSON.parse(packageJson.toString('utf8')) as PackageMetadata;
  const packageName = typeof metadata.name === 'string' ? metadata.name : '';
  const problems: TarballProblem[] = [];

  if (!entries.has('package/README.md')) {
    problems.push({kind: 'missing-readme', detail: `${packageName || '<unnamed>'} is missing package/README.md`});
  }

  if (metadata.private === true) {
    problems.push({kind: 'private', detail: `${packageName || '<unnamed>'} declares private: true`});
  }

  for (const field of dependencyFields) {
    const dependencies = metadata[field];

    if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
      continue;
    }

    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        problems.push({kind: 'workspace-range', detail: `${field}.${name} uses ${range}`});
      }
    }
  }

  const seenTargets = new Set<string>();

  for (const target of stringsIn([metadata.exports, metadata.main, metadata.types, metadata.bin])) {
    if (seenTargets.has(target)) {
      continue;
    }

    seenTargets.add(target);

    if (isTypeScriptSource(target)) {
      problems.push({kind: 'ts-target', detail: `Package target points at TypeScript source: ${target}`});
    } else if (!targetExists(target, entries)) {
      problems.push({kind: 'missing-target', detail: `Package target is missing from tarball: ${target}`});
    }
  }

  problems.push(...nonExecutableBinProblems(metadata.bin, modes));

  const declaredDependencies = new Set<string>();

  for (const field of dependencyFields) {
    const dependencies = metadata[field];

    if (typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies)) {
        declaredDependencies.add(name);
      }
    }
  }

  const moduleEntries = [...entries.entries()].filter(([name]) => {
    return /\.(?:js|mjs|d\.ts)$/.test(name);
  });

  for (const [name, contents] of moduleEntries) {
    for (const specifier of findImports(contents.toString('utf8'))) {
      const dependency = packageNameOf(specifier);

      if (
        dependency === undefined || packageBuiltinNames.has(dependency) || dependency === packageName
        || declaredDependencies.has(dependency)
      ) {
        continue;
      }

      problems.push({kind: 'undeclared-import', detail: `${name} imports undeclared package ${dependency}`});
    }
  }

  return problems;
};

const isMainModule = (url: string): boolean => {
  const entryPath = process.argv[1];

  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === url;
};

const run = async (arguments_: string[]): Promise<void> => {
  if (arguments_.length === 0) {
    console.error('Usage: node --import tsx build/npm/check-tarball.ts <tgz>...');
    process.exitCode = 1;

    return;
  }

  let foundProblems = false;

  for (const path of arguments_) {
    const problems = await checkTarball(path);

    if (problems.length === 0) {
      console.log(`${path}: no problems`);
      continue;
    }

    foundProblems = true;

    for (const problem of problems) {
      console.error(`${path}: ${problem.kind}: ${problem.detail}`);
    }
  }

  if (foundProblems) {
    process.exitCode = 1;
  }
};

if (isMainModule(import.meta.url)) {
  void run(process.argv.slice(2));
}
