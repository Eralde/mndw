import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  SHARED_DEPENDENCIES,
  pluginDependencies,
  sharedDependencyVersions,
  sharedImportMap,
  versionedBundleUrl,
} from '@mndw/sdk-internal/shared-dependencies';

const BUNDLE_STEM_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const VERSION_PATTERN = '^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$';

export interface SharedDependencySnapshot {
  readonly schemaVersion: 1;
  readonly bundleStemPattern: string;
  readonly versionPattern: string;
  readonly bundles: readonly {
    readonly bundle: string;
    readonly version: string;
    readonly specifiers: readonly string[];
    readonly framework: string;
    readonly url: string;
  }[];
  readonly importMap: Record<string, string>;
}

export type ProtocolDocumentMap = Record<string, unknown>;

function sdkVersion(repoRoot: string = resolve(import.meta.dirname, '../..')): string {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'frontend/sdk/package.json'), 'utf8')) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== 'string') {
    throw new Error('frontend/sdk/package.json has no version');
  }

  return packageJson.version;
}

function validateAuthority(): void {
  const bundles = new Set<string>();
  const specifiers = new Set<string>();
  const bundlePattern = new RegExp(BUNDLE_STEM_PATTERN);
  const versionPattern = new RegExp(VERSION_PATTERN);

  for (const entry of SHARED_DEPENDENCIES) {
    if (bundles.has(entry.bundle)) {
      throw new Error(`Duplicate shared bundle name: ${entry.bundle}`);
    }

    if (!bundlePattern.test(entry.bundle)) {
      throw new Error(`Invalid shared bundle name: ${entry.bundle}`);
    }

    if (!versionPattern.test(entry.version)) {
      throw new Error(`Invalid shared dependency version for ${entry.bundle}: ${entry.version}`);
    }

    if (entry.version.trim() === '') {
      throw new Error(`Missing shared dependency version for ${entry.bundle}`);
    }

    bundles.add(entry.bundle);

    for (const specifier of entry.specifiers) {
      if (specifiers.has(specifier)) {
        throw new Error(`Duplicate shared dependency specifier: ${specifier}`);
      }

      specifiers.add(specifier);
    }
  }

  const importMap = sharedImportMap();

  if (Object.keys(importMap).length !== specifiers.size) {
    throw new Error('Shared dependency import map has an unexpected specifier count.');
  }

  for (const entry of SHARED_DEPENDENCIES) {
    const url = versionedBundleUrl(entry);

    for (const specifier of entry.specifiers) {
      if (importMap[specifier] !== url) {
        throw new Error(`Import map target mismatch for ${specifier}`);
      }
    }
  }
}

export function createSharedDependencySnapshot(): SharedDependencySnapshot {
  validateAuthority();

  return {
    schemaVersion: 1,
    bundleStemPattern: BUNDLE_STEM_PATTERN,
    versionPattern: VERSION_PATTERN,
    bundles: SHARED_DEPENDENCIES.map((entry) => ({
      bundle: entry.bundle,
      version: entry.version,
      specifiers: entry.specifiers,
      framework: entry.framework,
      url: versionedBundleUrl(entry),
    })),
    importMap: sharedImportMap(),
  };
}

export function createProtocolDocuments(repoRoot?: string): ProtocolDocumentMap {
  const root = repoRoot ?? resolve(import.meta.dirname, '../..');
  const versions = sharedDependencyVersions();
  const vanillaSpecifiers = [...pluginDependencies('vanilla')].sort();

  return {
    'backend-client.json': {
      schemaVersion: 1,
      backendDescriptor: {
        required: ['routes', 'approval', 'enabled'],
        route: {transport: 'http|websocket', method: 'GET|HEAD|POST|PUT|PATCH|DELETE?', path: 'string',
          protocols: 'string[]?'},
        approval: ['approved', 'pending', 'denied'],
      },
      errorEnvelope: {
        required: ['error'],
        error: {code: 'string', message: 'string', detail: 'unknown|null'},
      },
    },
    'backend-descriptor.golden.json': {
      kind: 'backend-descriptor',
      descriptor: {
        routes: {
          status: {transport: 'http', method: 'GET', path: 'status'},
          events: {transport: 'websocket', path: 'events', protocols: ['json', 'cbor']},
        },
        approval: 'approved',
        enabled: true,
      },
    },
    'error-envelope.golden.json': {
      kind: 'error-envelope',
      response: {
        error: {
          code: 'NOT_APPROVED',
          message: 'plugin backend is not approved',
          detail: null,
        },
      },
    },
    'import-map.golden.json': {
      kind: 'import-map',
      imports: sharedImportMap(),
    },
    'lockfile.golden.json': {
      kind: 'lockfile',
      lockVersion: 1,
      plugin: {name: 'golden-widget', version: '1.2.3'},
      framework: 'vanilla',
      sdkVersion: sdkVersion(root),
      sharedDependencies: Object.fromEntries(vanillaSpecifiers.map((specifier) => [specifier, versions[specifier]])),
    },
    'shared-bundle-url.golden.json': {
      kind: 'shared-bundle-url',
      bundle: 'rxjs',
      version: '7.8.2',
      url: '/shared/rxjs@7.8.2.js',
    },
  };
}

export function generateSharedDependencyContracts(repoRoot: string, outputRoot: string = repoRoot): void {
  const snapshotPath = join(outputRoot, 'contracts/protocol/shared-deps.json');
  const documents = createProtocolDocuments(repoRoot);

  mkdirSync(join(outputRoot, 'contracts/protocol'), {recursive: true});
  writeFileSync(snapshotPath, `${JSON.stringify(createSharedDependencySnapshot(), null, 2)}\n`);

  for (const [relativePath, document] of Object.entries(documents)) {
    writeFileSync(join(outputRoot, 'contracts/protocol', relativePath), `${JSON.stringify(document, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(import.meta.dirname, '../..');

  generateSharedDependencyContracts(repoRoot);
}
