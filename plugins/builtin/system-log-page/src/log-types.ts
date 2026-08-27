export type LogLevel = 'Info' | 'Warning' | 'Error' | 'Critical' | 'Debug' | 'Notice';

export interface NormalizedLogRecord {
  readonly id: number;
  readonly timestamp: string;
  readonly ident: string;
  readonly level: LogLevel;
  readonly label: string;
  readonly text: string;
}
