import {describe, expect, it} from 'vitest';
import {DEFAULT_SETTINGS, SERVERS, resolveTarget, validateSettings} from './settings.js';

describe('settings', () => {
  it('accepts default settings and resolves the default built-in server', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({});
    expect(resolveTarget(DEFAULT_SETTINGS, SERVERS)).toEqual({
      host: 'spd-fisrv.hostkey.com',
      portFrom: 5201,
      portTo: 5209,
    });
  });

  it('reports invalid duration, stream count, custom host, and custom port', () => {
    expect(validateSettings({...DEFAULT_SETTINGS, duration: 4}).duration).toBeDefined();
    expect(validateSettings({...DEFAULT_SETTINGS, duration: 31}).duration).toBeDefined();
    expect(validateSettings({...DEFAULT_SETTINGS, streams: 0}).streams).toBeDefined();
    expect(validateSettings({...DEFAULT_SETTINGS, streams: 9}).streams).toBeDefined();
    expect(validateSettings({...DEFAULT_SETTINGS, serverId: 'custom', customHost: 'http://x'}).customHost)
      .toBeDefined();
    expect(validateSettings({...DEFAULT_SETTINGS, serverId: 'custom', customHost: ''}).customHost).toBeDefined();
    expect(
      validateSettings({...DEFAULT_SETTINGS, serverId: 'custom', customHost: 'example.net', customPort: 0}).customPort,
    )
      .toBeDefined();
    expect(
      validateSettings({...DEFAULT_SETTINGS, serverId: 'custom', customHost: 'example.net', customPort: 65536})
        .customPort,
    )
      .toBeDefined();
  });

  it('resolves a custom server to one configured port', () => {
    expect(
      resolveTarget({...DEFAULT_SETTINGS, serverId: 'custom', customHost: 'example.net', customPort: 5208}, SERVERS),
    )
      .toEqual({host: 'example.net', portFrom: 5208, portTo: 5208});
  });
});
