import diagnosticsSource from './DiagnosticsSettings.svelte?raw';
import {describe, expect, it} from 'vitest';

describe('DiagnosticsSettings layout', () => {
  it('keeps description and action in a token-spaced stack', () => {
    expect(diagnosticsSource).toMatch(/\.mndw-diagnostics-settings\s*\{[\s\S]*display:\s*grid;/u);
    expect(diagnosticsSource).toMatch(/\.mndw-diagnostics-settings\s*\{[\s\S]*gap:\s*var\(--mndw-space-2\)/u);
  });
});
