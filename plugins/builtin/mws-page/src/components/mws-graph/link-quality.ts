import type {MwsNode} from '../../domain/mws/mws.types';
import {formatRate, formatRssi, formatSpeed} from '../../format';

export type LinkQuality = 'good' | 'fair' | 'weak' | 'unknown';

export const WIRELESS_GOOD_RSSI = -55;
export const WIRELESS_FAIR_RSSI = -70;
export const WIRED_GOOD_SPEED = 1000;
export const WIRED_FAIR_SPEED = 100;

export function edgeType(node: MwsNode): 'wired' | 'wireless' {
  return node.backhaul !== null && node.backhaul.ap !== null ? 'wireless' : 'wired';
}

export function linkQuality(node: MwsNode): LinkQuality {
  const backhaul = node.backhaul;

  if (backhaul === null) {
    return 'unknown';
  }

  if (edgeType(node) === 'wireless') {
    const rssi = backhaul.rssi;

    if (rssi === null || !Number.isFinite(rssi)) {
      return 'unknown';
    }

    if (rssi >= WIRELESS_GOOD_RSSI) {
      return 'good';
    }

    if (rssi >= WIRELESS_FAIR_RSSI) {
      return 'fair';
    }

    return 'weak';
  }

  if (backhaul.speed === null) {
    return 'unknown';
  }

  const speed = Number(backhaul.speed.trim());

  if (!Number.isFinite(speed) || speed <= 0) {
    return 'unknown';
  }

  if (speed >= WIRED_GOOD_SPEED) {
    return 'good';
  }

  if (speed >= WIRED_FAIR_SPEED) {
    return 'fair';
  }

  return 'weak';
}

function includeSegment(segments: string[], value: string | null | undefined): void {
  if (value !== null && value !== undefined && value !== '' && value !== '—') {
    segments.push(value);
  }
}

export function edgeTooltip(
  node: MwsNode,
  translate: (key: string) => string = (key) => ({
    'graph.wireless': 'Wireless',
    'graph.wired': 'Wired',
    'graph.duplex': 'duplex',
  }[key] ?? key),
): string {
  const backhaul = node.backhaul;
  const segments: string[] = [edgeType(node) === 'wireless' ? translate('graph.wireless') : translate('graph.wired')];

  if (backhaul === null) {
    return segments[0];
  }

  if (edgeType(node) === 'wireless') {
    includeSegment(segments, formatRssi(backhaul.rssi));
    includeSegment(segments, formatRate(backhaul.txrate));
    includeSegment(segments, backhaul.mode);
  } else {
    includeSegment(segments, formatSpeed(backhaul.speed));
    includeSegment(
      segments,
      backhaul.duplex === null || backhaul.duplex === ''
        ? null
        : `${backhaul.duplex} ${translate('graph.duplex')}`,
    );
  }

  return segments.join(' · ');
}
