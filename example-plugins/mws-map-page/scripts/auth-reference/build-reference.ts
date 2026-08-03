import {build} from 'esbuild';
import {mkdir, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageDir = dirname(fileURLToPath(import.meta.url));
const source = join(packageDir, '../../../../.nocommit/rci-tools-core/src/session-manager/auth-protocol/index.ts');
const outputDir = join(packageDir, 'generated');
const repoDir = join(packageDir, '../../../..');
const pnpmStore = join(repoDir, 'node_modules', '.pnpm');
const exactPackageDir = (await readdir(pnpmStore)).find((name) =>
  name.startsWith('@rci-tools+core@https+++codeload.github.com+Eralde+rci-tools+tar.gz+85eb264d7d7c5e17781')
);

await mkdir(outputDir, {recursive: true});
await build({
  entryPoints: [source],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: join(outputDir, 'auth-protocol.mjs'),
  nodePaths: [
    join(packageDir, '../../node_modules'),
    join(repoDir, 'node_modules'),
    join(pnpmStore, 'jssha@3.3.2', 'node_modules'),
    join(pnpmStore, 'hash-wasm@4.12.0', 'node_modules'),
    join(pnpmStore, 'rxjs@7.8.2', 'node_modules'),
    ...(exactPackageDir ? [join(pnpmStore, exactPackageDir, 'node_modules')] : []),
  ],
  sourcemap: false,
});
