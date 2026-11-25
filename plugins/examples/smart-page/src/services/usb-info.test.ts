import {describe, expect, it, vi} from 'vitest';
import type {PluginRciManager} from '@mndw/sdk';
import {readUsbInfo} from './usb-info';

const usb = {
  device: {
    Media0: {
      'DEVPATH': '/devices/platform/11200000.xhci/usb2/2-1/2-1:1.0/host0/target0:0:0/0:0:0:0/block/sda',
      'manufacturer': 'Samsung',
      'port': '1',
      'product': 'PSSD T7',
      'serial': 'S6WZ1234',
      'usb-version': '3.20',
    },
  },
};

const media = {
  device: {
    Media0: {
      bus: 'usb',
      usb: {port: 1, version: '3.20'},
      manufacturer: 'Samsung',
      product: 'PSSD T7',
      serial: 'S6WZ1234',
      size: '2000398934016',
      partition: {name: 'sda1'},
    },
    FlashStorage: {
      bus: 'mtd',
      manufacturer: 'Keenetic',
      product: 'Flash',
      size: '16777216',
    },
  },
};

describe('readUsbInfo', () => {
  it.each([
    {
      name: 'matches the real USB and media shapes and ignores flash storage',
      usb,
      media,
      expected: new Map([['/dev/sda', {
        manufacturer: 'Samsung',
        product: 'PSSD T7',
        port: '1',
        usbVersion: '3.20',
        sizeBytes: '2000398934016',
      }]]),
    },
    {
      name: 'skips USB entries without DEVPATH',
      usb: {device: {Media0: {...usb.device.Media0, DEVPATH: undefined}}},
      media,
      expected: new Map(),
    },
    {
      name: 'matches the full block name when it shares a prefix with another device',
      usb: {device: {Media0: {...usb.device.Media0, DEVPATH: '/devices/usb/block/sdaa'}}},
      media,
      expected: new Map([['/dev/sdaa', {
        manufacturer: 'Samsung',
        product: 'PSSD T7',
        port: '1',
        usbVersion: '3.20',
        sizeBytes: '2000398934016',
      }]]),
    },
    {
      name: 'skips a partition nested below its whole disk block path',
      usb: {device: {Media0: {...usb.device.Media0, DEVPATH: '/devices/usb/block/sda/sda1'}}},
      media,
      expected: new Map(),
    },
    {
      name: 'maps two disks independently by their DEVPATH and media keys',
      usb: {device: {
        Media0: usb.device.Media0,
        Media1: {...usb.device.Media0, DEVPATH: '/devices/usb/block/sdb', product: 'Portable SSD'},
      }},
      media: {device: {
        Media0: media.device.Media0,
        Media1: {...media.device.Media0, product: 'Portable SSD', size: '1000'},
      }},
      expected: new Map([
        ['/dev/sda', {
          manufacturer: 'Samsung',
          product: 'PSSD T7',
          port: '1',
          usbVersion: '3.20',
          sizeBytes: '2000398934016',
        }],
        ['/dev/sdb', {
          manufacturer: 'Samsung',
          product: 'Portable SSD',
          port: '1',
          usbVersion: '3.20',
          sizeBytes: '1000',
        }],
      ]),
    },
    {
      name: 'uses available USB fields when the matching media entry is absent',
      usb,
      media: {device: {}},
      expected: new Map([['/dev/sda', {
        manufacturer: 'Samsung',
        product: 'PSSD T7',
        port: '1',
        usbVersion: '3.20',
        sizeBytes: null,
      }]]),
    },
    {
      name: 'returns an empty map for an RCI status-error envelope',
      usb: {status: [{status: 'error', message: 'Rejected'}]},
      media: {status: [{status: 'error', message: 'Rejected'}]},
      expected: new Map(),
    },
    {
      name: 'returns an empty map for malformed response shapes',
      usb: {device: ['unexpected']},
      media: null,
      expected: new Map(),
    },
    {
      name: 'uses null for missing or unknown display fields',
      usb: {device: {Media0: {DEVPATH: '/devices/usb/block/sdb'}}},
      media: {device: {Media0: {bus: 'usb'}}},
      expected: new Map([['/dev/sdb', {
        manufacturer: null,
        product: null,
        port: null,
        usbVersion: null,
        sizeBytes: null,
      }]]),
    },
  ])('$name', async ({usb: usbResponse, media: mediaResponse, expected}) => {
    const query = vi.fn().mockResolvedValue([usbResponse, mediaResponse]);

    await expect(readUsbInfo({query} as unknown as PluginRciManager)).resolves.toEqual(expected);
  });

  it('reads USB and media in one cancellable batch', async () => {
    const query = vi.fn().mockResolvedValue([usb, media]);
    const rci = {query} as unknown as PluginRciManager;
    const controller = new AbortController();

    await readUsbInfo(rci, controller.signal);

    expect(query).toHaveBeenCalledExactlyOnceWith([
      {path: 'show.usb', extractData: true},
      {path: 'show.media', extractData: true},
    ], {signal: controller.signal});
  });

  it('returns an empty map when RCI is absent or fails', async () => {
    await expect(readUsbInfo(undefined)).resolves.toEqual(new Map());
    await expect(readUsbInfo({query: vi.fn().mockRejectedValue(new Error('offline'))} as never)).resolves.toEqual(
      new Map(),
    );
  });
});
