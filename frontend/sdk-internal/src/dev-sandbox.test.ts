import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {type SandboxFsDeps, renderSandboxManifest, renderSandboxModule} from './dev-sandbox.js';

const pluginDir = path.resolve('/repo/plugins/examples/sample-page');
const manifestPath = path.join(pluginDir, 'manifest.json');
const validManifest = JSON.stringify({manifestVersion: 1, name: 'sandbox-widget', version: '0.0.0'});

function fakeFs(files: Record<string, string>): SandboxFsDeps {
  return {
    existsSync: (filePath) => Object.prototype.hasOwnProperty.call(files, filePath),
    readFileSync: (filePath) => {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) {
        throw new Error(`ENOENT ${filePath}`);
      }

      return files[filePath];
    },
  };
}

describe('renderSandboxModule', () => {
  it('re-exports createInstance from the plugin source entry', () => {
    const src = renderSandboxModule(pluginDir);

    expect(src).toContain('export {createInstance}');
    expect(src).toContain(path.join(pluginDir, 'src', 'index.ts'));
  });
});

describe('renderSandboxManifest', () => {
  it('exports parsed manifest JSON and its catalog base URL', () => {
    const src = renderSandboxManifest(pluginDir, fakeFs({[manifestPath]: validManifest}));

    expect(src).toContain('export default');
    expect(src).toContain('"name":"sandbox-widget"');
    expect(src).toContain(`/@fs${pluginDir}`);
  });

  it('throws visibly when the manifest is missing', () => {
    expect(() => renderSandboxManifest(pluginDir, fakeFs({}))).toThrow(/manifest\.json/);
  });

  it('throws visibly when the manifest is invalid JSON', () => {
    expect(() => renderSandboxManifest(pluginDir, fakeFs({[manifestPath]: '{ not json'}))).toThrow();
  });
});
