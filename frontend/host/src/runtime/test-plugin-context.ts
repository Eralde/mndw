import type {PluginRciManager, WidgetPluginContext} from '@mndw/sdk';
import {createTestPluginContext as createSdkTestPluginContext} from '@mndw/sdk/testing';

export type TestPluginContextOverrides =
  & Omit<Partial<WidgetPluginContext>, 'kind' | 'appearance' | 'storage' | 'device'>
  & {
    kind?: 'widget';
    appearance?: Partial<WidgetPluginContext['appearance']>;
    storage?: Partial<WidgetPluginContext['storage']>;
    device?: {info?: WidgetPluginContext['device']['info']; rci?: Partial<PluginRciManager>};
  };

export function createTestPluginContext(overrides: TestPluginContextOverrides = {}): WidgetPluginContext {
  const fixture = createSdkTestPluginContext({
    appearance: overrides.appearance,
    storage: overrides.storage,
    device: overrides.device,
    i18n: overrides.i18n,
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
  const {appearance: _appearance, storage: _storage, device: _device, ...flatOverrides} = overrides;

  Object.assign(context, flatOverrides, {
    appearance: fixture.context.appearance,
    storage: fixture.context.storage,
    device: fixture.context.device,
    kind: 'widget',
  });

  return Object.freeze(context);
}
