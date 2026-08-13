import {describe, expect, it} from 'vitest';
import {discoverBuiltinPlugins} from './builtin-plugins.js';

describe('built-in plugin discovery', () => {
  it('does not discover moved uploadable examples', () => {
    const names = discoverBuiltinPlugins();

    expect(names).not.toContain('ping-widget');
    expect(names).not.toContain('device-traffic-widget');
    expect(names.length).toBeGreaterThan(0);
  });
});
