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

export type ConnectionView =
  | {kind: 'none'}
  | {kind: 'wireless'; text: string}
  | {kind: 'wired'; speed: string; port: string};
