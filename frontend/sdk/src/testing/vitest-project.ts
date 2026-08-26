import {type UserConfig, configDefaults, defineConfig} from 'vitest/config';

export interface MndwVitestProjectOptions {
  environment: string;
  plugins?: UserConfig['plugins'];
  resolve?: UserConfig['resolve'];
  setupFiles?: string[];
  css?: boolean;
  extraExclude?: string[];
  extraTest?: Record<string, unknown>;
}

export function defineMndwVitestProject(options: MndwVitestProjectOptions): UserConfig {
  const test: Record<string, unknown> = {environment: options.environment};

  if (options.setupFiles !== undefined) {
    test.setupFiles = options.setupFiles;
  }

  if (options.css !== undefined) {
    test.css = options.css;
  }

  if (options.extraExclude !== undefined) {
    test.exclude = [...configDefaults.exclude, ...options.extraExclude];
  }

  if (options.extraTest !== undefined) {
    Object.assign(test, options.extraTest);
  }

  const config: UserConfig = {test};

  if (options.plugins !== undefined) {
    config.plugins = options.plugins;
  }

  if (options.resolve !== undefined) {
    config.resolve = options.resolve;
  }

  return defineConfig(config);
}
