import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  DestroyRef,
  type OnDestroy,
  type OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {CommonModule} from '@angular/common';
import {type Observable, Subscription, catchError, map, of, switchMap, timer} from 'rxjs';
import {formatSpeed, getSpeedUpperLimit} from '@mndw/ui';
import type {RrdTick} from '@mndw/sdk/rrd';
import type {ClockDate, NetworkInterface} from '../types/rci.types';
import {RciService} from '../services/rci.service';
import {PLUGIN_STORAGE, TRANSLATOR} from '../tokens';
import type {OpenSettingsFn} from '../open-settings-dialog';
import {getMostRecentRrdTimestamp, toTxRxChartData} from '../utils/chart-data.utils';
import {DEFAULT_REFRESH_MS, normalizeRefreshMs} from '../utils/refresh.utils';

const STORAGE_KEY = 'tx-rx-rrd-chart-interface';
const STORAGE_REFRESH = 'tx-rx-rrd-chart-refresh';
const DEVICE_TIME_INTERVAL = 30000;

type PollResult<T> = {ok: true; data: T} | {ok: false; error: unknown};

@Component({
  selector: 'tx-rx-app',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  imports: [CommonModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppComponent implements OnInit, OnDestroy {
  public readonly openSettings = input.required<OpenSettingsFn>();
  public readonly setTileTitle = input<(title: string) => void>();

  private readonly rciService = inject(RciService);
  private readonly storage = inject(PLUGIN_STORAGE);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly translator = inject(TRANSLATOR);

  protected readonly interfaceList = signal<NetworkInterface[]>([]);
  protected readonly selectedInterface = signal<string>('');
  protected readonly txData = signal<RrdTick[]>([]);
  protected readonly rxData = signal<RrdTick[]>([]);
  protected readonly clockTime = signal<Date | null>(null);
  protected readonly deviceTimeRrdTimestamp = signal<number | null>(null);
  private readonly interfaceError = signal('');
  private readonly trafficError = signal('');
  private readonly deviceTimeError = signal('');
  protected readonly storageWarning = signal('');
  protected readonly error = computed(
    () => this.interfaceError() || this.trafficError() || this.deviceTimeError(),
  );
  protected readonly loadingInterfaces = signal(true);
  protected readonly refresh = signal(DEFAULT_REFRESH_MS);
  protected readonly awaitingFirstTick = signal(false);

  protected readonly chartData = computed(() => {
    return toTxRxChartData(
      this.txData(),
      this.rxData(),
      this.clockTime(),
      this.deviceTimeRrdTimestamp(),
    );
  });
  protected readonly valueFormatter = formatSpeed;
  protected readonly valueDomain = computed(() => {
    const values = this.chartData().series.flatMap((series) => series.data.map((point) => point.value));
    const max = Math.max(...values, 0);

    return {min: 0, max: getSpeedUpperLimit(max)};
  });

  private pollingSub: Subscription | null = null;
  private deviceTimeSub: Subscription | null = null;
  private pollingGeneration = 0;

  protected readonly activeInterfaceName = computed(() => {
    const found = this.interfaceList().find((i) => i.id === this.selectedInterface());

    return found ? (found.description || found.id) : '';
  });

  public constructor() {
    effect(() => {
      const title = this.activeInterfaceName();
      const setTitle = this.setTileTitle();

      if (setTitle) {
        setTitle(title);
      }
    });
  }

  public ngOnInit(): Promise<void> {
    return this.loadInterfaces();
  }

  public ngOnDestroy(): void {
    this.stopPolling();
  }

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }

  protected retryLoad(): void {
    this.interfaceError.set('');
    this.trafficError.set('');
    this.deviceTimeError.set('');
    void this.loadInterfaces();
  }

  protected openSettingsDialog(): void {
    this.openSettings()({
      title: this.t('action.settings'),
      interfaces: this.interfaceList(),
      selectedInterface: this.selectedInterface(),
      refresh: this.refresh(),
      onInterfaceChange: (interfaceId) => this.onInterfaceChange(interfaceId),
      onRefreshChange: (refresh) => this.onRefreshChange(refresh),
    });
  }

  protected onInterfaceChange(interfaceId: string): void {
    const interfaceChanged = interfaceId !== this.selectedInterface();

    this.selectedInterface.set(interfaceId);

    if (interfaceChanged) {
      this.resetChartData();
    }

    if (interfaceId) {
      void this.saveSetting(STORAGE_KEY, interfaceId);
      this.startPolling();
    } else {
      void this.saveSetting(STORAGE_KEY, null);
      this.stopPolling();
      this.awaitingFirstTick.set(false);
    }
  }

  protected onRefreshChange(newRefresh: number): void {
    this.refresh.set(newRefresh);
    void this.saveSetting(STORAGE_REFRESH, String(newRefresh));

    if (this.selectedInterface()) {
      this.startPolling();
    }
  }

  private getInterfaceList(
    response: Record<string, {id: string; description?: string; traits?: string[]}>,
  ): NetworkInterface[] {
    return Object.values(response)
      .filter((netInterface) => {
        const traits = netInterface?.traits ?? [];

        return traits.includes('Ip') || traits.includes('Ip6');
      })
      .map((netInterface) => ({
        id: netInterface.id,
        description: netInterface.description,
      }));
  }

  private resetChartData(): void {
    this.txData.set([]);
    this.rxData.set([]);
    this.deviceTimeRrdTimestamp.set(null);
    this.trafficError.set('');
    this.awaitingFirstTick.set(this.selectedInterface() !== '');
  }

  private stopPolling(): void {
    this.pollingGeneration += 1;

    if (this.pollingSub) {
      this.pollingSub.unsubscribe();
      this.pollingSub = null;
    }

    if (this.deviceTimeSub) {
      this.deviceTimeSub.unsubscribe();
      this.deviceTimeSub = null;
    }
  }

  private isCurrentPoll(interfaceId: string, generation: number): boolean {
    return this.pollingGeneration === generation && this.selectedInterface() === interfaceId;
  }

  private pollRequest<T>(request: Observable<T>): Observable<PollResult<T>> {
    return request.pipe(
      map((data) => ({ok: true as const, data})),
      catchError((error: unknown) => of({ok: false as const, error})),
    );
  }

  private startPolling(): void {
    this.stopPolling();

    const interfaceId = this.selectedInterface();

    if (!interfaceId) { return; }

    const generation = this.pollingGeneration;

    if (this.txData().length === 0 && this.rxData().length === 0) {
      this.awaitingFirstTick.set(true);
    }

    this.pollingSub = timer(0, this.refresh()).pipe(
      switchMap(() => this.pollRequest(this.rciService.getInterfaceRrd(interfaceId, 0))),
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe((result) => {
        if (!this.isCurrentPoll(interfaceId, generation)) { return; }

        this.awaitingFirstTick.set(false);

        if (!result.ok) {
          this.trafficError.set(this.t('error.load-traffic'));
          console.error('[tx-rx-rrd-chart] Failed to load RRD data', result.error);

          return;
        }

        const {tx, rx} = result.data;
        const mostRecentTimestamp = getMostRecentRrdTimestamp(tx, rx);

        if (this.deviceTimeRrdTimestamp() === null && this.clockTime() !== null && mostRecentTimestamp !== null) {
          this.deviceTimeRrdTimestamp.set(mostRecentTimestamp);
        }

        this.txData.set(tx);
        this.rxData.set(rx);
        this.trafficError.set('');
      });

    this.deviceTimeSub = timer(0, DEVICE_TIME_INTERVAL).pipe(
      switchMap(() => this.pollRequest(this.rciService.getDeviceTime())),
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe((result) => {
        if (!this.isCurrentPoll(interfaceId, generation)) { return; }

        if (!result.ok) {
          this.deviceTimeError.set(this.t('error.load-device-time'));
          console.error('[tx-rx-rrd-chart] Failed to load device time', result.error);

          return;
        }

        this.deviceTimeError.set('');
        this.setDeviceTime(result.data);
      });
  }

  private async loadInterfaces(): Promise<void> {
    let savedInterface: string | null = null;
    let savedRefresh: string | null = null;

    try {
      savedInterface = await this.storage.get(STORAGE_KEY);
      savedRefresh = await this.storage.get(STORAGE_REFRESH);
      this.storageWarning.set('');
    } catch (ex) {
      this.storageWarning.set(this.t('warning.storage-unavailable'));
      console.error('[tx-rx-rrd-chart] Failed to read settings', ex);
    }

    if (savedRefresh) {
      this.refresh.set(normalizeRefreshMs(savedRefresh));
    }

    this.rciService.getInterfaces().pipe(
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe({
        next: (response) => {
          const list = this.getInterfaceList(response);

          this.interfaceList.set(list);
          this.loadingInterfaces.set(false);

          if (savedInterface && list.find((i) => i.id === savedInterface)) {
            this.selectedInterface.set(savedInterface);
            this.startPolling();
          } else if (savedInterface) {
            void this.saveSetting(STORAGE_KEY, null);
          }
        },
        error: (ex) => {
          this.loadingInterfaces.set(false);
          this.interfaceError.set(this.t('error.load-interfaces'));
          console.error('[tx-rx-rrd-chart]', ex);
        },
      });

    this.loadDeviceTime();
  }

  private async saveSetting(key: string, value: string | null): Promise<void> {
    try {
      if (value === null) {
        await this.storage.delete(key);
      } else {
        await this.storage.set(key, value);
      }
    } catch (ex) {
      this.storageWarning.set(this.t('warning.storage-unavailable'));
      console.error('[tx-rx-rrd-chart] Failed to save settings', ex);
    }
  }

  private loadDeviceTime(): void {
    this.rciService.getDeviceTime().pipe(
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe({
        next: (d) => {
          this.deviceTimeError.set('');
          this.setDeviceTime(d);
        },
        error: (ex) => {
          this.deviceTimeError.set(this.t('error.load-device-time'));
          console.error('[tx-rx-rrd-chart] Failed to load device time', ex);
        },
      });
  }

  private setDeviceTime(deviceTime: ClockDate): void {
    this.deviceTimeRrdTimestamp.set(getMostRecentRrdTimestamp(this.txData(), this.rxData()));
    this.clockTime.set(
      new Date(
        deviceTime.year,
        deviceTime.month - 1,
        deviceTime.day,
        deviceTime.hour,
        deviceTime.min,
        deviceTime.sec,
        deviceTime.msec,
      ),
    );
  }
}
