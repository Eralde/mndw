import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  DestroyRef,
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
import type {NetworkInterface, RrdTick} from '../types/rci.types';
import {RciService} from '../services/rci.service';
import {PLUGIN_STORAGE} from '../tokens';
import type {OpenSettingsFn} from '../open-settings-dialog';
import {toTxRxChartData} from '../utils/chart-data.utils';
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
export class AppComponent implements OnInit {
  public readonly openSettings = input.required<OpenSettingsFn>();
  public readonly setTileTitle = input<(title: string) => void>();

  private readonly rciService = inject(RciService);
  private readonly storage = inject(PLUGIN_STORAGE);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly interfaceList = signal<NetworkInterface[]>([]);
  protected readonly selectedInterface = signal<string>('');
  protected readonly txData = signal<RrdTick[]>([]);
  protected readonly rxData = signal<RrdTick[]>([]);
  protected readonly clockTime = signal<Date | null>(null);
  protected readonly error = signal<string>('');
  protected readonly loadingInterfaces = signal(true);
  protected readonly refresh = signal(DEFAULT_REFRESH_MS);

  protected readonly chartData = computed(() => {
    return toTxRxChartData(this.txData(), this.rxData(), this.clockTime());
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

  protected retryLoad(): void {
    this.error.set('');
    void this.loadInterfaces();
  }

  protected openSettingsDialog(): void {
    this.openSettings()({
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

    this.pollingSub = timer(0, this.refresh()).pipe(
      switchMap(() => this.rciService.getInterfaceRrd(interfaceId, 0)),
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe({
        next: ({tx, rx}) => {
          this.txData.set(tx);
          this.rxData.set(rx);
          this.error.set('');
        },
        error: (ex) => {
          this.error.set('Failed to load traffic data');
          console.error('[tx-rx-rrd-chart] Failed to load RRD data', ex);
        },
      });

    this.deviceTimeSub = timer(0, DEVICE_TIME_INTERVAL).pipe(
      switchMap(() => this.rciService.getDeviceTime()),
      takeUntilDestroyed(this.destroyRef),
    )
      .subscribe({
        next: (d) => {
          this.clockTime.set(new Date(d.year, d.month - 1, d.day, d.hour, d.min, d.sec, d.msec));
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
          this.error.set('Failed to load interfaces');
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
          this.clockTime.set(new Date(d.year, d.month - 1, d.day, d.hour, d.min, d.sec, d.msec));
        },
        error: (ex) => {
          console.error('[tx-rx-rrd-chart]', ex);
        },
      });
  }
}
