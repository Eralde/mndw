import {NEVER, Observable, type Observable as ObservableType, fromEvent, map, takeUntil} from 'rxjs';
import {findNodeById} from './domain/mws/map-builder';
import type {MwsNode} from './domain/mws/mws.types';

export interface NodeDetailsSource {
  open(nodeId: string, signal: AbortSignal): ObservableType<MwsNode | null>;
}

function abortedSignal(signal: AbortSignal): ObservableType<unknown> {
  if (signal.aborted) {
    return NEVER;
  }

  return fromEvent(signal, 'abort');
}

export class LiveMapNodeDetailsSource implements NodeDetailsSource {
  public constructor(private readonly snapshots$: Observable<MwsNode[]>) {}

  public open(nodeId: string, signal: AbortSignal): Observable<MwsNode | null> {
    if (signal.aborted) {
      return new Observable((subscriber) => subscriber.complete());
    }

    return this.snapshots$.pipe(
      map((roots) => findNodeById(roots, nodeId)),
      takeUntil(abortedSignal(signal)),
    );
  }
}
