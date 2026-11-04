import {resolve} from 'node:path';

import {generateManifestSchema} from '../../../../build/contracts/generate.js';

const repoRoot = resolve(import.meta.dirname, '../../../../');

generateManifestSchema({repoRoot});
console.log(`Generated ${resolve(repoRoot, 'frontend/sdk/manifest.schema.json')}`);
