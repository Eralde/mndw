import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildBackend} from '../tooling/cli/src/backend-build.js';
import {packPlugin} from '../tooling/cli/src/pack.js';
import {zipDirectory} from '../tooling/cli/src/zip.js';
import {PRODUCT_TARGETS, type ProductTarget} from './targets.js';
import {verifyElfBytes} from './packaging/build-ipk.js';

export const EXAMPLE_TARGETS = PRODUCT_TARGETS;

export function expectedExampleArchiveNames(): string[] {
  return [
    'device-traffic-widget.zip',
    ...EXAMPLE_TARGETS.map((target) => `ping-widget-${target}.zip`),
  ];
}

interface ExampleBuildOptions {
  readonly repoRoot?: string;
  readonly outputRoot?: string;
}

function writeArchive(outputRoot: string, name: string, packedRoot: string): void {
  writeFileSync(join(outputRoot, name), zipDirectory(packedRoot));
}

function verifyPackedBackend(packedRoot: string, target: ProductTarget): void {
  const backendPath = join(packedRoot, 'backend', 'ping-util');

  verifyElfBytes(readFileSync(backendPath), target);

  const artifact = JSON.parse(readFileSync(join(packedRoot, 'mndw-artifact.json'), 'utf8')) as {
    backend?: {target?: unknown; files?: readonly {path?: unknown; sha256?: unknown}[]};
  };
  const metadata = artifact.backend;

  if (metadata?.target !== target || metadata.files?.length !== 1) {
    throw new Error(`ping-widget metadata does not describe target ${target}`);
  }

  const digest = createHash('sha256').update(readFileSync(backendPath))
    .digest('hex');
  const file = metadata.files[0];

  if (file?.path !== 'backend/ping-util' || file.sha256 !== digest) {
    throw new Error(`ping-widget metadata does not match injected backend for ${target}`);
  }
}

function promoteOutput(stagingRoot: string, outputRoot: string): void {
  const backupRoot = `${outputRoot}.previous`;

  if (existsSync(outputRoot)) {
    renameSync(outputRoot, backupRoot);
  }

  try {
    renameSync(stagingRoot, outputRoot);
  } catch (error) {
    if (existsSync(backupRoot)) {
      renameSync(backupRoot, outputRoot);
    }

    throw error;
  }

  if (existsSync(backupRoot)) {
    rmSync(backupRoot, {recursive: true, force: true});
  }
}

export async function buildExamplePlugins(options: ExampleBuildOptions = {}): Promise<string[]> {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dirname, '..'));
  const outputRoot = resolve(options.outputRoot ?? join(repoRoot, 'out', 'example-plugins'));
  const sourceRoot = join(repoRoot, 'plugins', 'examples');
  const stagingRoot = mkdtempSync(join(dirname(outputRoot), '.mndw-example-'));
  const archiveRoot = join(stagingRoot, 'archives');

  mkdirSync(archiveRoot);

  try {
    const trafficSource = join(sourceRoot, 'device-traffic-widget');
    const trafficPacked = join(stagingRoot, 'packed-device-traffic-widget');

    await packPlugin(trafficSource, {outDir: trafficPacked});
    writeArchive(archiveRoot, 'device-traffic-widget.zip', trafficPacked);

    for (const target of EXAMPLE_TARGETS) {
      const backendOut = join(stagingRoot, `backend-${target}`);
      const pingSource = join(sourceRoot, 'ping-widget');
      const backend = buildBackend({
        pluginDir: pingSource,
        plugin: 'ping-widget',
        target,
        outDir: backendOut,
      });

      if (backend === null) {
        throw new Error('ping-widget has no backend build hook');
      }

      const packedRoot = join(stagingRoot, `packed-ping-widget-${target}`);

      await packPlugin(pingSource, {
        outDir: packedRoot,
        backendOverride: {
          target,
          sourceRoot: backendOut,
          files: backend.binaries.map((binary) => ({
            source: join(backendOut, binary.source),
            destination: binary.destination,
            mode: 0o755,
          })),
        },
      });
      verifyPackedBackend(packedRoot, target);
      writeArchive(archiveRoot, `ping-widget-${target}.zip`, packedRoot);
    }

    const names = expectedExampleArchiveNames();

    promoteOutput(archiveRoot, outputRoot);
    rmSync(stagingRoot, {recursive: true, force: true});

    return names;
  } catch (error) {
    if (existsSync(stagingRoot)) {
      rmSync(stagingRoot, {recursive: true, force: true});
    }

    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildExamplePlugins()
    .then((names) => {
      process.stdout.write(`Built example plugin archives: ${names.join(', ')}\n`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
