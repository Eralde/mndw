import {type DeviceInfoData, type HostInfo, parseCapabilityList} from '@mndw/sdk';
import {firstValueFrom, timeout} from 'rxjs';
import {API_TIMEOUT_MS} from '../constants.js';
import {emptySwitchports} from '../runtime/device-info-schema.js';
import {processDeviceUsbInfo} from '../runtime/device-usb.js';
import type {MgmtClient} from './mgmt-client.js';
import {getShowVersion} from './rci/show-version/index.js';
import {getTheme} from './theme.service.js';
import {getLocale} from './locale.service.js';

export function fetchHostInfo(): Promise<HostInfo> {
  return Promise.resolve({
    theme: getTheme(),
    locale: getLocale(),
  });
}

function unknownDeviceData(): Omit<DeviceInfoData, 'switchports' | 'usb'> {
  return {
    deviceName: 'Unknown',
    vendor: 'Unknown',
    manufacturer: 'Unknown',
    model: 'Unknown',
    series: 'Unknown',
    region: 'Unknown',
    hwId: 'Unknown',
    hwVersion: 'Unknown',
    firmwareVersion: 'Unknown',
    firmwareRelease: 'Unknown',
    features: [],
    components: [],
  };
}

async function readVersion(): Promise<Omit<DeviceInfoData, 'switchports' | 'usb'>> {
  try {
    const version = await firstValueFrom(getShowVersion().pipe(timeout(API_TIMEOUT_MS)));

    return {
      deviceName: version.device ?? 'Unknown',
      vendor: version.vendor ?? 'Unknown',
      manufacturer: version.manufacturer ?? 'Unknown',
      model: version.model ?? 'Unknown',
      series: version.series ?? 'Unknown',
      region: version.region ?? 'Unknown',
      hwId: version.hw_id ?? 'Unknown',
      hwVersion: version.hw_version ?? 'Unknown',
      hwType: version.hw_type,
      firmwareVersion: version.title ?? 'Unknown',
      firmwareRelease: version.release ?? 'Unknown',
      architecture: version.arch,
      features: parseCapabilityList(version.ndw.features),
      components: parseCapabilityList(version.ndw.components),
    };
  } catch {
    return unknownDeviceData();
  }
}

export async function fetchDeviceInfo(
  mgmtClient: Pick<MgmtClient, 'getDeviceHardware'>,
): Promise<DeviceInfoData> {
  const versionPromise = readVersion();

  const hardwarePromise = Promise.resolve()
    .then(() => mgmtClient.getDeviceHardware())
    .catch(() => ({switchports: emptySwitchports(), usbPortCount: 0}));

  const [version, hardware] = await Promise.all([versionPromise, hardwarePromise]);

  const featureSet = new Set(version.features.map((feature) => feature.toLowerCase()));
  const usb = processDeviceUsbInfo(hardware.usbPortCount, (name) => featureSet.has(name.toLowerCase()));

  return {...version, switchports: hardware.switchports, usb};
}
