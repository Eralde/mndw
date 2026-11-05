import type {BackendClient, PluginContext} from '@mndw/sdk';
import {createTestPluginContext} from '@mndw/sdk/testing';

export function makeStubContext(overrides: {backend?: Partial<BackendClient>}): PluginContext {
  return createTestPluginContext({backend: overrides.backend as BackendClient | undefined}).context;
}
