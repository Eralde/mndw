import type {RssiQuality} from './rssi.js';

export const DASH = '—';

export interface TitledText {
  text: string;
  title?: string;
}

export interface LinkStatusView {
  tone: 'up' | 'down' | 'unavailable';
  label: string;
}

export interface ClientNameView {
  displayName: string;
  link: LinkStatusView;
}

export interface WirelessConnectionView {
  kind: 'wireless';
  label: string;
  rssi: string;
  rate: string;
  quality: RssiQuality;
  title?: string;
}

export type ConnectionView =
  | {kind: 'none'}
  | WirelessConnectionView
  | {kind: 'wired'; speed: string; port: string};
