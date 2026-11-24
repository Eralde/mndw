import {type Column, column} from '@mndw/ui';
import {vueCell} from '@mndw/ui-vue';
import type {Translator} from '@mndw/sdk';
import type {ClientRecord} from '../services/clients.js';
import {formatCompactDuration, formatElapsed, formatFullDuration} from '../services/format-duration.js';
import ClientNameCell from './ClientNameCell.vue';
import ConnectionCell from './ConnectionCell.vue';
import TitledTextCell from './TitledTextCell.vue';
import {type ClientNameView, type ConnectionView, DASH, type LinkStatusView, type TitledText} from './cell-views.js';
import {type RssiQuality, type RssiThresholds, rssiQuality} from './rssi.js';

function wiredSpeedText(speed: number | null | undefined): string {
  return speed === undefined || !Number.isFinite(speed) ? DASH : `${speed} Mbps`;
}

function wiredPortText(translator: Translator, port: string | null | undefined): string {
  return port === null || port === undefined || port === '' || port === 'undefined'
    ? DASH
    : `${translator.t('port')} ${port}`;
}

function linkView(translator: Translator, row: ClientRecord): LinkStatusView {
  if (row.link === 'up') {
    return {tone: 'up', label: translator.t('link.online')};
  }

  if (row.link === 'down') {
    return {tone: 'down', label: translator.t('link.offline')};
  }

  return {tone: 'unavailable', label: translator.t('link.unavailable')};
}

function nameView(translator: Translator, row: ClientRecord): ClientNameView {
  return {displayName: row.displayName, link: linkView(translator, row)};
}

const RSSI_LEVEL_KEYS: Record<Exclude<RssiQuality, 'unknown'>, string> = {
  good: 'rssi-level.good',
  fair: 'rssi-level.fair',
  weak: 'rssi-level.weak',
};

function rssiLevelTitle(translator: Translator, quality: RssiQuality): string | undefined {
  return quality === 'unknown' ? undefined : translator.t(RSSI_LEVEL_KEYS[quality]);
}

function rssiText(rssi: number | null): string {
  return rssi === null || !Number.isFinite(rssi) ? DASH : String(rssi);
}

function connectionView(translator: Translator, row: ClientRecord, thresholds: RssiThresholds): ConnectionView {
  const {connection, connectionType} = row;

  if (connectionType === 'unknown' || connection === null) {
    return {kind: 'none'};
  }

  if ('accessPointId' in connection) {
    const quality = rssiQuality(connection.rssi, thresholds);

    return {
      kind: 'wireless',
      label: translator.t('rssi'),
      rssi: rssiText(connection.rssi),
      rate: `${connection.txrate} Mbps`,
      quality,
      title: rssiLevelTitle(translator, quality),
    };
  }

  return {kind: 'wired', speed: wiredSpeedText(connection.speed), port: wiredPortText(translator, connection.port)};
}

function durationView(seconds: number | null, format: (value: number) => string): TitledText {
  return seconds === null
    ? {text: DASH, title: undefined}
    : {text: format(seconds), title: formatFullDuration(seconds)};
}

export function buildColumns(translator: Translator, thresholds: RssiThresholds): Column<ClientRecord>[] {
  return [
    column<ClientRecord>()({
      id: 'name',
      label: translator.t('column.name'),
      accessor: (row) => nameView(translator, row),
      sticky: 'start',
      width: '12rem',
      hideable: false,
      renderer: vueCell<ClientRecord, ClientNameView>()(ClientNameCell),
    }),
    column<ClientRecord>()({
      id: 'ip',
      label: translator.t('column.ip'),
      accessor: (row) => row.ip ?? DASH,
      kind: 'text',
      hideable: true,
    }),
    column<ClientRecord>()({
      id: 'connection',
      label: translator.t('column.connection'),
      accessor: (row) => connectionView(translator, row, thresholds),
      renderer: vueCell<ClientRecord, ConnectionView>()(ConnectionCell),
      hideable: true,
    }),
    column<ClientRecord>()({
      id: 'uptime',
      label: translator.t('column.uptime'),
      accessor: (row) => durationView(row.uptime, formatCompactDuration),
      renderer: vueCell<ClientRecord, TitledText>()(TitledTextCell),
      nowrap: true,
      hideable: true,
    }),
    column<ClientRecord>()({
      id: 'lastSeen',
      label: translator.t('column.last-seen'),
      accessor: (row) => durationView(row.lastSeen, formatElapsed),
      renderer: vueCell<ClientRecord, TitledText>()(TitledTextCell),
      nowrap: true,
      hideable: true,
    }),
  ];
}
