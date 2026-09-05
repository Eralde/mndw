import {
  ChangeDetectorRef,
  Component,
  type OnChanges,
  type OnInit,
  type SimpleChanges,
  inject,
  input,
} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {MwsApiService, type ScheduleDefinition, type SystemSettings} from '../../api/mws-api.service';
import {type MwsWriteResult, MwsWriteService} from '../../services/mws-write.service';
import {TRANSLATOR} from '../../tokens';

type SettingField = 'backhaul' | 'auto-ap-shutdown' | 'auto-update' | 'auto-update-schedule';

@Component({
  selector: 'mws-settings-tab',
  standalone: true,
  templateUrl: './settings-tab.component.html',
  styleUrls: ['./settings-tab.component.scss'],
})
export class SettingsTabComponent implements OnChanges, OnInit {
  private readonly api = inject(MwsApiService);
  private readonly write = inject(MwsWriteService);
  private readonly translator = inject(TRANSLATOR);
  private readonly changeDetector = inject(ChangeDetectorRef);

  public readonly active = input(true);

  protected settings: SystemSettings | null = null;
  protected loading = true;
  protected loadError = '';
  protected savingField: SettingField | null = null;
  protected saveError = '';
  protected saveSuccess = '';
  private initialized = false;
  private loaded = false;

  public ngOnChanges(changes: SimpleChanges): void {
    if (this.initialized && changes.active !== undefined && this.active() && !this.loaded) {
      this.scheduleLoad();
    }
  }

  public ngOnInit(): void {
    this.initialized = true;

    if (this.active()) {
      this.scheduleLoad();
    }
  }

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }

  protected scheduleEntries(): Array<[string, ScheduleDefinition]> {
    return this.settings === null ? [] : Object.entries(this.settings.schedules);
  }

  protected scheduleLabel(id: string, schedule: ScheduleDefinition): string {
    return schedule.description === id ? id : `${schedule.description} (${id})`;
  }

  protected schedulePreview(schedule: ScheduleDefinition | null): string {
    return schedule === null
      ? ''
      : schedule.action.map((action) => `${action.action} ${action.hour}:${action.min} (${action.dow})`).join(', ');
  }

  protected selectedSchedule(): ScheduleDefinition | null {
    const id = this.settings?.autoUpdateSchedule;

    return id === undefined || id === null ? null : this.settings?.schedules[id] ?? null;
  }

  protected async onBackhaulChange(event: Event): Promise<void> {
    const enabled = this.checkboxValue(event);
    const result = await this.saveSetting('backhaul', () => this.write.setBackhaul(enabled));

    if (result?.ok === true && this.settings !== null) {
      this.settings = {...this.settings, backhaulEnabled: enabled};
    }
  }

  protected async onAutoApShutdownChange(event: Event): Promise<void> {
    const enabled = this.checkboxValue(event);
    const result = await this.saveSetting('auto-ap-shutdown', () => this.write.setAutoApShutdown(enabled));

    if (result?.ok === true && this.settings !== null) {
      this.settings = {...this.settings, autoApShutdownEnabled: enabled};
    }
  }

  protected async onAutoUpdateChange(event: Event): Promise<void> {
    const enabled = this.checkboxValue(event);
    const result = await this.saveSetting('auto-update', () => this.write.setAutoUpdate(enabled));

    if (result?.ok === true && this.settings !== null) {
      this.settings = {...this.settings, autoUpdateEnabled: enabled};
    }
  }

  protected async onScheduleChange(event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value;
    const result = await this.saveSetting(
      'auto-update-schedule',
      () => this.write.setAutoUpdateSchedule(value === '' ? null : value),
    );

    if (result?.ok === true && this.settings !== null) {
      this.settings = {...this.settings, autoUpdateSchedule: value === '' ? null : value};
    }
  }

  protected async retry(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  private scheduleLoad(): void {
    setTimeout(() => {
      void this.load();
    }, 0);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.loadError = '';

    try {
      this.settings = await this.first(this.api.showSystemSettings());
      this.loaded = true;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : this.t('settings.load-failed');
    } finally {
      this.loading = false;
      this.changeDetector.detectChanges();
    }
  }

  private async saveSetting(
    field: SettingField,
    operation: () => Promise<MwsWriteResult>,
  ): Promise<MwsWriteResult | null> {
    this.savingField = field;
    this.saveError = '';
    this.saveSuccess = '';

    try {
      const result = await operation();

      if (result.ok) {
        this.saveSuccess = this.t('settings.save-success');
      } else {
        this.saveError = this.errorFromResult(result);
      }

      return result;
    } catch (error) {
      this.saveError = error instanceof Error ? error.message : this.t('settings.save-failed');

      return null;
    } finally {
      this.savingField = null;
    }
  }

  private errorFromResult(result: MwsWriteResult): string {
    return result.steps.flatMap((step) => step.status).find((status) => status.status === 'error')?.message
      ?? this.t('settings.save-failed');
  }

  private checkboxValue(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  private first<T>(source: import('rxjs').Observable<T>): Promise<T> {
    return firstValueFrom(source);
  }
}
