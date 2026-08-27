import {getContext, hasContext, setContext} from 'svelte';
import type {HostServices} from './host-services.js';

const HOST_SERVICES_CONTEXT = Symbol('mndw.host-services');

export function setHostServices(services: HostServices): void {
  setContext(HOST_SERVICES_CONTEXT, services);
}

export function getHostServices(): HostServices {
  if (!hasContext(HOST_SERVICES_CONTEXT)) {
    throw new Error('Host services context was not set');
  }

  return getContext<HostServices>(HOST_SERVICES_CONTEXT);
}

export function createHostServicesContext(services: HostServices): Map<unknown, unknown> {
  return new Map([[HOST_SERVICES_CONTEXT, services]]);
}
