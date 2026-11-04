import type {WidgetPluginContext} from '@mndw/sdk';
import {createTestPluginContext as createSdkTestPluginContext} from '@mndw/sdk/testing';

export type TestPluginContextOverrides = Partial<Omit<WidgetPluginContext, 'kind'>> & {kind?: 'widget'};

export function createTestPluginContext(overrides: TestPluginContextOverrides = {}): WidgetPluginContext {
  const fixture = createSdkTestPluginContext({
    theme: overrides.theme,
    locale: overrides.locale,
    palette: overrides.palette,
    i18n: overrides.i18n,
    rciManager: overrides.rciManager,
    backend: overrides.backend,
    telemetry: overrides.telemetry,
    instanceId: overrides.instanceId,
  });
  const context = Object.create(null) as WidgetPluginContext;

  const descriptors = Object.getOwnPropertyDescriptors(fixture.context);

  for (const descriptor of Object.values(descriptors)) {
    descriptor.configurable = true;

    if ('value' in descriptor) {
      descriptor.writable = true;
    }
  }

  Object.defineProperties(context, descriptors);
  Object.assign(context, overrides, {kind: 'widget'});

  return Object.freeze(context);
}
