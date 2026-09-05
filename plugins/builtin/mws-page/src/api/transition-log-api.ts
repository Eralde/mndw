import type {RciBackgroundProcess, RciManager} from '@rci-tools/core';
import type {Observable} from 'rxjs';
import {map} from 'rxjs/operators';
import {normalizeTransitionLogFrame} from '../domain/transition-log/transition-log-normalizer';
import type {TransitionLogEntry} from '../domain/transition-log/transition-log.types';

export interface TransitionLogStream {
  readonly process: RciBackgroundProcess;
  readonly data$: Observable<TransitionLogEntry[]>;
}

export function createTransitionLogStream(
  rci: RciManager,
  names: Readonly<Record<string, string>> = {},
): TransitionLogStream {
  const process = rci.queueBackgroundProcess({path: 'show.mws.log'});

  return {
    process,
    data$: process.data$.pipe(map((frame) => normalizeTransitionLogFrame(frame, names))),
  };
}
