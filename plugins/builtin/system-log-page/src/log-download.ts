import type {NormalizedLogRecord} from './log-types';

export interface DownloadBrowser {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): HTMLAnchorElement;
}

export function formatLogText(records: readonly NormalizedLogRecord[]): string {
  if (records.length === 0) {
    return '';
  }

  return `${
    records.map((record) => `${record.timestamp} ${record.ident} [${record.level}] ${record.text}`).join('\n')
  }\n`;
}

export function downloadLog(records: readonly NormalizedLogRecord[], browser: DownloadBrowser): void {
  const blob = new Blob([formatLogText(records)], {type: 'text/plain;charset=utf-8'});
  const url = browser.createObjectURL(blob);
  const anchor = browser.createAnchor();

  anchor.href = url;
  anchor.download = 'system-log.txt';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  browser.revokeObjectURL(url);
}
