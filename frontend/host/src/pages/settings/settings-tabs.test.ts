import {describe, expect, it} from 'vitest';
import {SETTINGS_TAB_DEFS} from './settings-tabs.js';

describe('settings tab registry', () => {
  it('contains unique complete metadata in navigation order', () => {
    expect(SETTINGS_TAB_DEFS).toHaveLength(3);
    expect(new Set(SETTINGS_TAB_DEFS.map((tab) => tab.id)).size).toBe(SETTINGS_TAB_DEFS.length);
    expect(new Set(SETTINGS_TAB_DEFS.map((tab) => tab.route)).size).toBe(SETTINGS_TAB_DEFS.length);
    expect(SETTINGS_TAB_DEFS.every((tab) => Boolean(tab.labelKey) && Boolean(tab.icon))).toBe(true);
    expect(SETTINGS_TAB_DEFS.map((tab) => tab.id)).toEqual(['general', 'diagnostics', 'plugins']);
  });
});
