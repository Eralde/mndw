export type TransitionEventType = 'connected' | 'left' | 'transition' | 'pmk-cache' | 'fast-transition';

export interface RawTransitionLogEndpoint {
  ap?: string;
  band?: string | number;
}

export interface RawTransitionLogEvent {
  timestamp?: string;
  mac?: string;
  left?: string | RawTransitionLogEndpoint;
  ap?: string;
  band?: string | number;
  roam?: 'ft' | 'pmk' | string;
  segment?: string | number;
  id?: string | number;
}

export interface RawTransitionLogFrame {
  continued?: boolean;
  log?: Record<string, RawTransitionLogEvent>;
}

export interface TransitionLogEntry {
  timestamp: number;
  client: string;
  from: string | null;
  to: string | null;
  band: string | null;
  segment: string | null;
  eventType: TransitionEventType;
  id: string;
}
