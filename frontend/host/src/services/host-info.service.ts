import type {HostInfo} from '@mndw/sdk';
import {firstValueFrom, timeout} from 'rxjs';
import {API_TIMEOUT_MS} from '../constants.js';
import {getShowVersion} from './rci/show-version/index.js';
import {getTheme} from './theme.service.js';

export async function fetchHostInfo(): Promise<HostInfo> {
  const showVersion$ = getShowVersion();

  const version = await firstValueFrom(
    showVersion$.pipe(timeout(API_TIMEOUT_MS)),
  );

  return {
    deviceName: version.device ?? 'Unknown',
    vendor: version.vendor ?? 'Unknown',
    firmwareVersion: version.title ?? 'Unknown',
    theme: getTheme(),
  };
}
