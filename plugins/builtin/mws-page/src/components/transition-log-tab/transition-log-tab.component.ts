import {Component, type OnChanges, type OnDestroy, type SimpleChanges, inject, input, signal} from '@angular/core';
import type {Subscription} from 'rxjs';
import {MwsApiService} from '../../api/mws-api.service';
import {transitionLogCsv} from '../../domain/transition-log/transition-log-csv';
import {
  ALL_TRANSITION_EVENT_TYPES,
  type TransitionLogFilters,
  filterTransitionLog,
} from '../../domain/transition-log/transition-log-filters';
import type {TransitionEventType, TransitionLogEntry} from '../../domain/transition-log/transition-log.types';
import {MwsDataService} from '../../services/mws-data.service';
import {TRANSLATOR} from '../../tokens';

const EVENT_TYPE_LABELS: Record<TransitionEventType, string> = {
  'connected': 'transition-log.connected',
  'left': 'transition-log.left',
  'transition': 'transition-log.transition',
  'pmk-cache': 'transition-log.pmk-cache',
  'fast-transition': 'transition-log.fast-transition',
};

@Component({
  selector: 'mws-transition-log-tab',
  standalone: true,
  templateUrl: './transition-log-tab.component.html',
  styleUrls: ['./transition-log-tab.component.scss'],
})
export class TransitionLogTabComponent implements OnChanges, OnDestroy {
  private readonly api = inject(MwsApiService);
  private readonly data = inject(MwsDataService, {optional: true});
  private readonly translator = inject(TRANSLATOR);

  public readonly active = input(false);

  protected readonly eventTypes = ALL_TRANSITION_EVENT_TYPES;
  protected selectedEventTypes: TransitionEventType[] = [...ALL_TRANSITION_EVENT_TYPES];
  protected clientFilter = '';
  protected sourceFilter = '';
  protected targetFilter = '';
  protected currentSince: number | null = null;
  protected streamError = '';
  protected readonly entries = signal(new Map<string, TransitionLogEntry>());

  private streamSubscription: Subscription | null = null;
  private streamProcess: {abort: () => boolean} | null = null;

  public ngOnChanges(changes: SimpleChanges): void {
    if (!changes.active) {
      return;
    }

    if (this.active()) {
      this.startStream();
    } else {
      this.stopStream();
    }
  }

  public ngOnDestroy(): void {
    this.stopStream();
  }

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }

  protected eventLabel(type: TransitionEventType): string {
    return this.t(EVENT_TYPE_LABELS[type]);
  }

  protected formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  protected visibleEntries(): TransitionLogEntry[] {
    const filters: TransitionLogFilters = {
      eventTypes: this.selectedEventTypes,
      client: this.clientFilter,
      source: this.sourceFilter,
      target: this.targetFilter,
      currentSince: this.currentSince,
    };

    return filterTransitionLog([...this.entries().values()], filters);
  }

  protected onEventTypeChange(type: TransitionEventType, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;

    this.selectedEventTypes = checked
      ? [...new Set([...this.selectedEventTypes, type])]
      : this.selectedEventTypes.filter((entry) => entry !== type);
  }

  protected onClientFilter(event: Event): void {
    this.clientFilter = (event.target as HTMLInputElement).value;
  }

  protected onSourceFilter(event: Event): void {
    this.sourceFilter = (event.target as HTMLInputElement).value;
  }

  protected onTargetFilter(event: Event): void {
    this.targetFilter = (event.target as HTMLInputElement).value;
  }

  protected onTimeFilter(event: Event): void {
    this.currentSince = (event.target as HTMLSelectElement).value === 'current' ? Date.now() : null;
  }

  protected downloadCsv(): void {
    const blob = new Blob([transitionLogCsv(this.visibleEntries())], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = 'mws-transition-log.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private startStream(): void {
    if (this.streamSubscription !== null) {
      return;
    }

    this.streamError = '';

    const stream = this.api.startTransitionLogStream(this.displayNames());

    this.streamProcess = stream.process;

    this.streamSubscription = stream.data$.subscribe({
      next: (entries) => {
        this.entries.update((current) => {
          const next = new Map(current);

          for (const entry of entries) {
            next.set(entry.id, entry);
          }

          return next;
        });
      },
      error: (error: unknown) => {
        this.streamError = error instanceof Error ? error.message : this.t('transition-log.stream-failed');
        this.streamSubscription = null;
      },
    });
  }

  private stopStream(): void {
    this.streamSubscription?.unsubscribe();
    this.streamSubscription = null;

    if (this.streamProcess !== null) {
      this.streamProcess.abort();
      this.streamProcess = null;
    }
  }

  private displayNames(): Record<string, string> {
    const names: Record<string, string> = {};

    if (this.data === null) {
      return names;
    }

    const visit = (node: import('../../domain/mws/mws.types').MwsNode): void => {
      names[node.mac] = node.name;

      for (const client of node.clients) {
        names[client.mac] = client.name;
      }

      for (const child of node.children) {
        visit(child.node);
      }
    };

    for (const root of this.data.roots()) {
      visit(root);
    }

    return names;
  }
}
