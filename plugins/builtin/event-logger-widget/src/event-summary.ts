import type {MndwEvent, Translator} from '@mndw/sdk';

const BYTE_UNIT_KEYS = ['size.b', 'size.kb', 'size.mb', 'size.gb', 'size.tb'] as const;

/** Byte counts are raw payload data; the summary shows the same number in a size a person can scan. */
function formatBytes(bytes: number, translator: Translator): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < BYTE_UNIT_KEYS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const formatted = translator.formatNumber(
    value,
    unit === 0
      ? {maximumFractionDigits: 0}
      : {maximumFractionDigits: 1, minimumFractionDigits: 1},
  );

  return `${formatted} ${translator.t(BYTE_UNIT_KEYS[unit])}`;
}

/**
 * Builds the one-line, translated description shown in a row summary.
 *
 * The default branch keeps a row readable when a newer daemon emits a topic this build does not know.
 */
export function summarizeEvent(event: MndwEvent, translator: Translator): string {
  switch (event.topic) {
    case 'wan.connected':
      return translator.t('summary.wan.connected', {
        address: event.payload.address,
        interface: event.payload.interface,
      });
    case 'wan.disconnected':
      return translator.t('summary.wan.disconnected', {interface: event.payload.interface});
    case 'net.ip_changed':
      return translator.t('summary.net.ip_changed', {
        address: event.payload.address,
        interface: event.payload.interface,
        mask: event.payload.mask,
      });
    case 'net.dhcp_lease':
      return translator.t('summary.net.dhcp_lease', {
        action: event.payload.action,
        hostname: event.payload.hostname,
        ip: event.payload.ip,
      });
    case 'net.dns_changed': {
      const resolvers = event.payload.resolvers.join(', ');

      return resolvers === ''
        ? translator.t('summary.net.dns_changed_empty')
        : translator.t('summary.net.dns_changed', {resolvers});
    }
    case 'wifi.client_join':
      return translator.t('summary.wifi.client_join', {
        band: event.payload.band,
        mac: event.payload.mac,
        ssid: event.payload.ssid,
      });
    case 'wifi.client_leave':
      return translator.t('summary.wifi.client_leave', {
        band: event.payload.band,
        mac: event.payload.mac,
        ssid: event.payload.ssid,
      });
    case 'firewall.rebuilt':
      return translator.t('summary.firewall.rebuilt', {
        table: event.payload.table,
        table_type: event.payload.table_type,
      });
    case 'usb.attached':
      return translator.t('summary.usb.attached', {
        model: event.payload.model,
        vendor: event.payload.vendor,
      });
    case 'usb.detached':
      return translator.t('summary.usb.detached', {
        device: event.payload.device,
        port: event.payload.port,
      });
    case 'fs.mounted':
      return translator.t('summary.fs.mounted', {
        directory: event.payload.directory,
        label: event.payload.label,
      });
    case 'fs.unmounted':
      return translator.t('summary.fs.unmounted', {
        directory: event.payload.directory,
        label: event.payload.label,
      });
    case 'clock.synced': {
      const offset = event.payload.offset_ms;

      return offset === undefined
        ? translator.t('summary.clock.synced')
        : translator.t('summary.clock.synced_offset', {offset: translator.formatNumber(offset)});
    }
    case 'schedule.fired':
      return translator.t('summary.schedule.fired', {
        action: event.payload.action,
        name: event.payload.name,
      });
    case 'button.pressed':
      return translator.t('summary.button.pressed', {
        button: event.payload.button,
        gesture: event.payload.gesture,
      });
    case 'auth.login':
      return translator.t(event.payload.success ? 'summary.auth.login' : 'summary.auth.login_failed', {
        ip: event.payload.ip,
        user: event.payload.user,
      });
    case 'firmware.available':
      return translator.t('summary.firmware.available', {version: event.payload.version});
    case 'plugin.installed':
      return translator.t('summary.plugin.installed', {
        name: event.payload.name,
        version: event.payload.version,
      });
    case 'plugin.removed':
      return translator.t('summary.plugin.removed', {name: event.payload.name});
    case 'plugin.approved':
      return translator.t('summary.plugin.approved', {
        name: event.payload.name,
        version: event.payload.version,
      });
    case 'plugin.started':
      return translator.t('summary.plugin.started', {name: event.payload.name});
    case 'plugin.stopped':
      return translator.t('summary.plugin.stopped', {
        name: event.payload.name,
        reason: event.payload.reason,
      });
    case 'daemon.started':
      return translator.t('summary.daemon.started', {version: event.payload.version});
    case 'daemon.stopping':
      return translator.t('summary.daemon.stopping', {reason: event.payload.reason});
    case 'daemon.updated':
      return translator.t('summary.daemon.updated', {version: event.payload.version});
    case 'storage.low':
      return translator.t('summary.storage.low', {
        available: formatBytes(event.payload.available_bytes, translator),
        path: event.payload.path,
        threshold: formatBytes(event.payload.threshold_bytes, translator),
      });
    case 'telemetry.gathering_changed':
      return translator.t(event.payload.enabled ? 'summary.telemetry.enabled' : 'summary.telemetry.disabled');
    default:
      return String((event as {topic?: string}).topic ?? '');
  }
}
