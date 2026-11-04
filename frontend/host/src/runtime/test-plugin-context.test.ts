import {describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import {createTestPluginContext} from './test-plugin-context.js';

describe('createTestPluginContext', () => {
  it('provides deterministic values for every PluginContext field', () => {
    const context = createTestPluginContext();

    expect(context.rciManager).toBeDefined();
    expect(context.storage).toBeDefined();
    expect(context.sharedStorage).toBeDefined();
    expect(context.locale).toBe('en');
    expect(context.theme).toBe('light');
    expect(context.deviceInfo.deviceName).toBe('');
    expect(context.i18n.t('missing')).toBe('missing');
    expect(context.instanceId).toBe('test:1');
    expect(context.kind).toBe('widget');
    expect(context.backend).toBeUndefined();
    expect(context.theme$).toBeDefined();
    expect(context.locale$).toBeDefined();
    expect(context.palette$).toBeDefined();
    expect(context.palette).toBeDefined();
    expect(typeof context.overlay.closeAll).toBe('function');
    expect(context.pageRoute).toBeUndefined();
    expect(context.setTileTitle).toBeUndefined();
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('preserves overrides and exposes the same live TestI18n', () => {
    const i18n = createTestI18n({message: 'Hello'}, 'en');
    const setTileTitle = vi.fn();
    const context = createTestPluginContext({i18n, setTileTitle});

    expect(context.i18n).toBe(i18n);
    expect(context.setTileTitle).toBe(setTileTitle);
    i18n.setLocale('ru', {message: 'Привет'});
    expect(context.i18n.t('message')).toBe('Привет');
  });
});
