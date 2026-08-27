import type {BackendClient, PluginContext} from '@mndw/sdk';

export function makeStubContext(overrides: {backend?: Partial<BackendClient>}): PluginContext {
  const base = {
    i18n: {
      locale: 'en',
      direction: 'ltr' as const,
      t: (key: string) => key,
      formatNumber: (value: number) => String(value),
      formatDate: (value: Date) => value.toISOString(),
      onChange: () => () => {},
    },
    hostInfo: {deviceName: 'test-device'},
    onThemeChange: () => () => {},
    onPaletteChange: () => () => {},
    getTokens: () => ({}),
    backend: overrides.backend,
  };

  // Test-only partial context: production code reads only fields above.
  return base as unknown as PluginContext;
}
