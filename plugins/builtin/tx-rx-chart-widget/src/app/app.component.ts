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
import {Subscription, switchMap, timer} from 'rxjs';
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
  protected readonly error = signal<string>('');
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
    this.error.set('');
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
    this.selectedInterface.set(interfaceId);

    if (interfaceId) {
      this.storage.set(STORAGE_KEY, interfaceId);
      this.startPolling();
    } else {
      this.storage.delete(STORAGE_KEY);
      this.stopPolling();
      this.txData.set([]);
      this.rxData.set([]);
      this.deviceTimeRrdTimestamp.set(null);
      this.awaitingFirstTick.set(false);
    }
  }

  protected onRefreshChange(newRefresh: number): void {
    this.refresh.set(newRefresh);
    this.storage.set(STORAGE_REFRESH, String(newRefresh));

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

  private stopPolling(): void {
    if (this.pollingSub) {
      this.pollingSub.unsubscribe();
      this.pollingSub = null;
    }

    if (this.deviceTimeSub) {
      this.deviceTimeSub.unsubscribe();
      this.deviceTimeSub = null;
    }
  }

  private startPolling(): void {
    this.stopPolling();

    if (!this.selectedInterface()) { return; }

    const interfaceId = this.selectedInterface();

    if (this.txData().length === 0 && this.rxData().length === 0) {
      this.awaitingFirstTick.set(true);
    }

    this.pollingSub = timer(0, this.refresh()).pipe(
      switchMap(() => this.rciService.getInterfaceRrd(interfaceId, 0)),
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe({
        next: ({tx, rx}) => {
          const mostRecentTimestamp = getMostRecentRrdTimestamp(tx, rx);

          if (this.deviceTimeRrdTimestamp() === null && this.clockTime() !== null && mostRecentTimestamp !== null) {
            this.deviceTimeRrdTimestamp.set(mostRecentTimestamp);
          }

          this.txData.set(tx);
          this.rxData.set(rx);
          this.awaitingFirstTick.set(false);
          this.error.set('');
        },
        error: (ex) => {
          this.awaitingFirstTick.set(false);
          this.error.set(this.t('error.load-traffic'));
          console.error('[tx-rx-rrd-chart] Failed to load RRD data', ex);
        },
      });

    this.deviceTimeSub = timer(0, DEVICE_TIME_INTERVAL).pipe(
      switchMap(() => this.rciService.getDeviceTime()),
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe({
        next: (d) => {
          this.setDeviceTime(d);
        },
        error: (ex) => {
          console.error('[tx-rx-rrd-chart]', ex);
        },
      });
  }

  private async loadInterfaces(): Promise<void> {
    let savedInterface: string | null;
    let savedRefresh: string | null;

    try {
      savedInterface = await this.storage.get(STORAGE_KEY);
      savedRefresh = await this.storage.get(STORAGE_REFRESH);
    } catch {
      this.loadingInterfaces.set(false);

      return;
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
            void this.storage.delete(STORAGE_KEY);
          }
        },
        error: (ex) => {
          this.loadingInterfaces.set(false);
          this.error.set(this.t('error.load-interfaces'));
          console.error('[tx-rx-rrd-chart]', ex);
        },
      });

    this.loadDeviceTime();
  }

  private loadDeviceTime(): void {
    this.rciService.getDeviceTime().pipe(
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe({
        next: (d) => {
          this.setDeviceTime(d);
        },
        error: (ex) => {
          console.error('[tx-rx-rrd-chart]', ex);
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
