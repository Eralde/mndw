import {describe, expectTypeOf, it} from 'vitest';
import type {
  PluginBackend,
  PluginBackendAccess,
  PluginBackendMethod,
  PluginExecBackend,
  PluginExecRoute,
  PluginHttpRoute,
  PluginManifest,
  PluginPermission,
  PluginServiceBackend,
  PluginWebSocketRoute,
  WidgetSize,
} from './manifest.js';
import type {
  PluginBackendAccessOutput,
  PluginBackendMethodOutput,
  PluginBackendOutput,
  PluginExecBackendOutput,
  PluginExecRouteOutput,
  PluginHttpRouteOutput,
  PluginManifestOutput,
  PluginPermissionOutput,
  PluginServiceBackendOutput,
  PluginWebSocketRouteOutput,
  WidgetSizeOutput,
} from './manifest-schema.js';

describe('manifest type single-sourcing', () => {
  it('keeps normalized outputs assignable to public compatibility views', () => {
    expectTypeOf<PluginBackendAccessOutput>().toEqualTypeOf<PluginBackendAccess>();
    expectTypeOf<PluginBackendMethodOutput>().toEqualTypeOf<PluginBackendMethod>();
    expectTypeOf<PluginPermissionOutput>().toEqualTypeOf<PluginPermission>();
    expectTypeOf<PluginManifestOutput>().toMatchTypeOf<PluginManifest>();
    expectTypeOf<PluginHttpRouteOutput>().toMatchTypeOf<PluginHttpRoute>();
    expectTypeOf<PluginWebSocketRouteOutput>().toMatchTypeOf<PluginWebSocketRoute>();
    expectTypeOf<PluginExecRouteOutput>().toMatchTypeOf<PluginExecRoute>();
    expectTypeOf<PluginExecBackendOutput>().toMatchTypeOf<PluginExecBackend>();
    expectTypeOf<PluginServiceBackendOutput>().toMatchTypeOf<PluginServiceBackend>();
    expectTypeOf<PluginBackendOutput>().toMatchTypeOf<PluginBackend>();
    expectTypeOf<WidgetSizeOutput>().toEqualTypeOf<WidgetSize>();
  });
});
