import type {PluginRciManager} from '@mndw/sdk';

export interface UsbInfo {
  manufacturer: string | null;
  product: string | null;
  port: string | null;
  usbVersion: string | null;
  sizeBytes: string | null;
}

export type UsbInfoMap = ReadonlyMap<string, UsbInfo>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function recordsFromResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  if (isRecord(value.data)) {
    return recordsFromResponse(value.data);
  }

  if (isRecord(value.device)) {
    return value.device;
  }

  return value;
}

function readText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function readNestedText(record: Record<string, unknown>, key: string, nestedKey: string): string | null {
  const nested = isRecord(record[key]) ? record[key] : {};

  return readText(nested[nestedKey]);
}

function rawMediaRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Reads display-only USB metadata in one batched RCI request. */
export async function readUsbInfo(
  rci: PluginRciManager | undefined,
  signal?: AbortSignal,
): Promise<Map<string, UsbInfo>> {
  if (rci === undefined) {
    return new Map();
  }

  try {
    const query = [
      {path: 'show.usb', extractData: true},
      {path: 'show.media', extractData: true},
    ];
    const responses = await rci.query(query as never, signal === undefined ? undefined : {signal});

    if (!Array.isArray(responses)) {
      return new Map();
    }

    const usbDevices = recordsFromResponse(responses[0]);
    const mediaDevices = recordsFromResponse(responses[1]);
    const result = new Map<string, UsbInfo>();

    for (const [key, rawUsb] of Object.entries(usbDevices)) {
      if (!isRecord(rawUsb)) {
        continue;
      }

      const devPath = readText(rawUsb.DEVPATH);
      const match = devPath?.match(/\/block\/([^/]+)$/);

      if (match?.[1] === undefined) {
        continue;
      }

      const rawMedia = mediaDevices[key];
      const media = isRecord(rawMedia) && rawMedia.bus === 'usb' ? rawMedia : {};
      const port = readNestedText(rawMediaRecord(rawMedia), 'usb', 'port') ?? readText(rawUsb.port);
      const usbVersion = readNestedText(rawMediaRecord(rawMedia), 'usb', 'version')
        ?? readText(rawUsb['usb-version']);

      result.set(`/dev/${match[1]}`, {
        manufacturer: readText(media.manufacturer) ?? readText(rawUsb.manufacturer),
        product: readText(media.product) ?? readText(rawUsb.product),
        port,
        usbVersion,
        sizeBytes: readText(media.size),
      });
    }

    return result;
  } catch {
    return new Map();
  }
}
