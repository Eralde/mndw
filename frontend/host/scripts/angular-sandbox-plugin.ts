import fs from 'node:fs';
import path from 'node:path';
import type {AngularCompiler, AngularCompilerOutput} from '@mndw/angular-compiler';
import {createAngularCompiler} from '@mndw/angular-compiler';
import type {ModuleNode, Plugin, ViteDevServer} from 'vite';

const GLOBAL_STYLES_PREFIX = 'virtual:mndw-angular-global-styles:';

export interface AngularSandboxPluginDeps {
  createCompiler?: (pluginDir: string) => AngularCompiler;
  readFileSync?: (filePath: string) => string;
}

export function isAngularPlugin(pluginDir: string): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(pluginDir, 'tsconfig.json'), 'utf8')) as unknown;

    return config !== null && typeof config === 'object' && 'angularCompilerOptions' in config;
  } catch {
    return false;
  }
}

const defaultDeps: Required<AngularSandboxPluginDeps> = {
  createCompiler: createAngularCompiler,
  readFileSync: (filePath) => fs.readFileSync(filePath, 'utf8'),
};

/**
 * A Vite adapter for the shared incremental Angular compiler. Vite continues to use source
 * paths as module ids, while this plugin supplies Angular-emitted JavaScript for those ids.
 */
export function angularSandboxPlugin(
  pluginDir: string,
  deps: AngularSandboxPluginDeps = {},
): Plugin {
  const resolvedPluginDir = path.resolve(pluginDir);
  const sourceDir = path.join(resolvedPluginDir, 'src');
  const mergedDeps = {...defaultDeps, ...deps};
  const compiler = mergedDeps.createCompiler(resolvedPluginDir);
  let output: AngularCompilerOutput;

  try {
    output = compiler.compileInitial();
  } catch (error) {
    compiler.dispose();
    throw error;
  }
  const globalStylesId = `${GLOBAL_STYLES_PREFIX}${encodeURIComponent(resolvedPluginDir)}`;
  const resolvedGlobalStylesId = `\0${globalStylesId}.js`;

  const isSourceFile = (id: string): boolean => {
    const sourcePath = path.resolve(stripQuery(id));
    const relativePath = path.relative(sourceDir, sourcePath);

    return !relativePath.startsWith('..') && path.extname(sourcePath) === '.ts' && !sourcePath.endsWith('.d.ts');
  };

  const transform = (_code: string, id: string): {code: string; map: null} | null => {
    const sourcePath = path.resolve(stripQuery(id));

    if (!isSourceFile(sourcePath)) {
      return null;
    }

    const outputPath = output.sourceToOutput(sourcePath);

    if (outputPath === undefined || !fs.existsSync(outputPath)) {
      return null;
    }

    let compiled = mergedDeps.readFileSync(outputPath);

    if (sourcePath === path.join(sourceDir, 'index.ts') && output.globalStylesPath !== undefined) {
      compiled = `${compiled}\nimport ${JSON.stringify(globalStylesId)};\n`;
    }

    return {code: compiled, map: null};
  };

  const handleHotUpdate = ({file, server}: {file: string; server: ViteDevServer}): ModuleNode[] | undefined => {
    const sourcePath = path.resolve(stripQuery(file));

    if (!isAngularResource(sourcePath, sourceDir)) {
      return undefined;
    }

    try {
      output = compiler.update([sourcePath]);
    } catch (error) {
      server.config.logger.error(`[mndw-angular] ${errorMessage(error)}`);

      return [];
    }

    const affected = [...server.moduleGraph.idToModuleMap.values()]
      .filter((module) => module.id !== null && isSourceFile(module.id));
    const globalStylesModule = server.moduleGraph.getModuleById(resolvedGlobalStylesId);

    if (globalStylesModule !== undefined) {
      affected.push(globalStylesModule);
    }

    for (const module of affected) {
      server.moduleGraph.invalidateModule(module);
    }

    return affected;
  };

  return {
    name: 'mndw-angular-sandbox',
    enforce: 'pre',
    resolveId(id) {
      if (id === globalStylesId) {
        return resolvedGlobalStylesId;
      }

      return undefined;
    },
    load(id) {
      if (id !== resolvedGlobalStylesId) {
        return undefined;
      }

      const css = output.globalStylesPath === undefined ? '' : mergedDeps.readFileSync(output.globalStylesPath);
      const styleKey = JSON.stringify(globalStylesId);

      return `const css = ${JSON.stringify(css)};
const key = ${styleKey};
if (typeof document !== 'undefined') {
  let style = document.querySelector('style[data-mndw-angular-global="' + key + '"]');
  if (style === null) {
    style = document.createElement('style');
    style.setAttribute('data-mndw-angular-global', key);
    document.head.appendChild(style);
  }
  style.textContent = css;
}
export default css;
`;
    },
    transform,
    handleHotUpdate,
    configureServer(server) {
      server.httpServer?.once('close', () => compiler.dispose());
    },
    closeBundle() {
      compiler.dispose();
    },
  };
}

function stripQuery(id: string): string {
  return id.split('?', 1)[0];
}

function isAngularResource(file: string, sourceDir: string): boolean {
  const relativePath = path.relative(sourceDir, file);

  return !relativePath.startsWith('..') && ['.ts', '.html', '.scss', '.css'].includes(path.extname(file));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
