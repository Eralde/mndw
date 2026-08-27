import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** Test-only fixture loader. Production code must never import this module. */
export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'src', 'fixtures', name), 'utf8')) as T;
}
