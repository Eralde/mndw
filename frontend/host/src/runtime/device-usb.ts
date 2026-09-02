import type {DeviceUsb} from '@mndw/sdk';

export function processDeviceUsbInfo(
  usbPortCount: number,
  hasFeature: (name: string) => boolean,
): DeviceUsb {
  const count = hasFeature('single_usb_port')
    ? 1
    : Math.max(0, Math.trunc(usbPortCount));

  if (count === 0) {
    return {ports: []};
  }

  const usb3Capable = hasFeature('usb_3') || hasFeature('usb_3_conf');

  if (!usb3Capable) {
    return {ports: Array.from({length: count}, () => 'usb2')};
  }

  const usb3Index = hasFeature('usb_3_first') ? 0 : count - 1;
  const ports = Array.from({length: count}, (_, index): 'usb2' | 'usb3' => index === usb3Index ? 'usb3' : 'usb2');

  return {ports};
}
