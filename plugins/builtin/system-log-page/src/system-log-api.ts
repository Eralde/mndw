import type {PluginRciManager} from '@mndw/sdk';
import {map} from 'rxjs/operators';
import type {Observable} from 'rxjs';
import type {RciBackgroundProcess} from '@rci-tools/core';
import {DEFAULT_MAX_LINES, normalizeLogResponse} from './log-normalizer';
import type {NormalizedLogRecord} from './log-types';

export interface SystemLogStream {
  readonly process: RciBackgroundProcess;
  readonly data$: Observable<NormalizedLogRecord[]>;
}

export interface SystemLogApi {
  showLogOnce(): Observable<NormalizedLogRecord[]>;
  startLogStream(): SystemLogStream;
  clearLog(): Observable<unknown>;
}

export function createSystemLogApi(rci: PluginRciManager): SystemLogApi {
  return {
    showLogOnce(): Observable<NormalizedLogRecord[]> {
      return rci.queue({path: 'show.log', data: {'once': true, 'max-lines': DEFAULT_MAX_LINES}}).pipe(
        map((response) => normalizeLogResponse(response)),
      );
    },
    startLogStream(): SystemLogStream {
      const process = rci.queueBackgroundProcess({path: 'show.log', data: {'max-lines': DEFAULT_MAX_LINES}});

      return {
        process,
        data$: process.data$.pipe(map((response) => normalizeLogResponse(response))),
      };
    },
    clearLog(): Observable<unknown> {
      return rci.queue({path: 'system.log.clear'});
    },
  };
}
