import {type Readable, get} from 'svelte/store';
import {describe, expect, it} from 'vitest';

import {createTestPluginContext} from '../testing/plugin-context.js';

describe('Svelte store contract', () => {
  it('reads theme$ through the Svelte store contract', () => {
    const fixture = createTestPluginContext();
    // Svelte's runtime adapts RxJS Subscription objects, but its declarations still require a function unsubscriber.
    const themeStore = fixture.context.theme$ as unknown as Readable<typeof fixture.context.theme>;

    expect(get(themeStore)).toBe('light');
    fixture.setTheme('dark');
    expect(get(themeStore)).toBe('dark');

    fixture.unmount();
  });
});
