import type {MwsBackhaul, MwsNode} from '../../domain/mws/mws.types';
import {DASH, formatRate, formatRssi, formatSpeed} from '../../format';

export type LinkQuality = 'good' | 'fair' | 'weak' | 'unknown';

export interface RssiThresholds {
  readonly good: number;
  readonly fair: number;
}

export const DEFAULT_RSSI_THRESHOLDS: RssiThresholds = {good: -55, fair: -70};
export const WIRED_GOOD_SPEED = 1000;
export const WIRED_FAIR_SPEED = 100;

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** The Nodes tab rule: any wireless backhaul field marks a wireless link. */
export function isWirelessBackhaul(backhaul: MwsBackhaul | null): boolean {
  return backhaul !== null
    && (present(backhaul.mode) || present(backhaul.txrate) || present(backhaul.rssi) || present(backhaul.security));
}

export function edgeType(node: MwsNode): 'wired' | 'wireless' {
  return node.backhaul !== null && node.backhaul.ap !== null ? 'wireless' : 'wired';
}

export function linkQuality(node: MwsNode, thresholds: RssiThresholds = DEFAULT_RSSI_THRESHOLDS): LinkQuality {
  const backhaul = node.backhaul;

  if (backhaul === null) {
    return 'unknown';
  }

  if (edgeType(node) === 'wireless') {
    const rssi = backhaul.rssi;

    if (rssi === null || !Number.isFinite(rssi)) {
      return 'unknown';
    }

    if (rssi >= thresholds.good) {
      return 'good';
    }

    if (rssi >= thresholds.fair) {
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

/** The rate shown next to a link, matching the Nodes tab, or null when there is none. */
export function edgeLinkValue(node: MwsNode): string | null {
  const backhaul = node.backhaul;

  if (backhaul === null) {
    return null;
  }

  const value = isWirelessBackhaul(backhaul) ? formatRate(backhaul.txrate) : formatSpeed(backhaul.speed);

  return value === DASH ? null : value;
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
