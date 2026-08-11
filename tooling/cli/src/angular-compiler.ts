import {
  type AngularCompileResult,
  AngularCompilerError,
  compileAngular as compileSharedAngular,
} from '@mndw/angular-compiler';

import {CliError} from './errors.js';

export type { AngularCompileResult };

export function compileAngular(pluginDir: string, sourceEntry = 'src/index.ts'): AngularCompileResult {
  try {
    return compileSharedAngular(pluginDir, sourceEntry);
  } catch (error) {
    if (error instanceof AngularCompilerError) {
      throw new CliError(error.message);
    }

    throw error;
  }
}
