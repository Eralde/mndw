import {type Readable, get} from 'svelte/store';
import {describe, expect, it} from 'vitest';

import {createTestPluginContext} from '../testing/plugin-context.js';

describe('Svelte store contract', () => {
  it('reads appearance.theme$ through the Svelte store contract', () => {
    const fixture = createTestPluginContext();
    // Svelte's runtime adapts RxJS Subscription objects, but its declarations still require a function unsubscriber.
    const themeStore = fixture.context.appearance.theme$ as unknown as Readable<
      typeof fixture.context.appearance.theme
    >;

    expect(get(themeStore)).toBe('light');
    fixture.setTheme('dark');
    expect(get(themeStore)).toBe('dark');

    fixture.unmount();
  });
});
