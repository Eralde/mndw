import type {DeviceInfo, DeviceInfoData, MndwThemeName} from '@mndw/sdk';

export interface HostInfo {
  locale: string;
  theme: MndwThemeName;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}

export function createDeviceInfoContext(data: DeviceInfoData): DeviceInfo {
  const switchports = {
    list: data.switchports.list.map((port) => ({...port})),
    layout: data.switchports.layout.map((row) => [...row]),
    hasPortStats: data.switchports.hasPortStats,
  };
  const usb = {ports: [...data.usb.ports]};
  const features = [...data.features];
  const components = [...data.components];
  const featureSet = new Set(features.map((feature) => feature.toLowerCase()));
  const componentSet = new Set(components.map((component) => component.toLowerCase()));
  const deviceInfo: DeviceInfo = {
    ...data,
    features,
    components,
    switchports,
    usb,
    hasFeature: (name: string): boolean => featureSet.has(name.toLowerCase()),
    hasComponent: (name: string): boolean => componentSet.has(name.toLowerCase()),
  };

  return deepFreeze(deviceInfo);
}
