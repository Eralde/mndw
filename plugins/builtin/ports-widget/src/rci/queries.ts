import type {RciQuery, Switchport} from '@mndw/sdk';

export const LINK_PATH = 'show.interface';
export const STAT_PATH = 'show.interface.stat';
export const CAPABILITIES_PATH = 'show.interface.ethernet.capabilities';
export const PORT_DESCRIPTIONS_PATH = 'show.rc.interface';
export const HOTSPOT_PATH = 'show.ip.hotspot';
export const INTERFACE_WRITE_PATH = 'interface';
export const SAVE_CONFIGURATION_PATH = 'system.configuration.save';

export function linkQuery(port: Switchport): RciQuery {
  return {path: LINK_PATH, data: {name: port.interfaceId}};
}

export function statQuery(port: Switchport): RciQuery {
  return {path: STAT_PATH, data: {name: port.interfaceId}};
}

export function capabilitiesQuery(port: Switchport): RciQuery {
  return {path: CAPABILITIES_PATH, data: {name: port.interfaceId}};
}

export function portDescriptionsQuery(): RciQuery {
  return {path: PORT_DESCRIPTIONS_PATH};
}

export function hotspotQuery(): RciQuery {
  return {path: HOTSPOT_PATH};
}

export function portDescriptionWriteQueries(interfaceId: string, description: string | null): RciQuery[] {
  return [
    {
      path: INTERFACE_WRITE_PATH,
      data: {
        name: interfaceId,
        description: description === null ? {no: true} : description,
      },
    },
    {path: SAVE_CONFIGURATION_PATH},
  ];
}
