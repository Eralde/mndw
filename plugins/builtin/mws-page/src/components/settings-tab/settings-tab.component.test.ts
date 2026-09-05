import '@angular/compiler';
import {TestBed} from '@angular/core/testing';
import {createTestI18n} from '@mndw/sdk/testing';
import {of, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MwsWriteResult} from '../../services/mws-write.service';
import {MwsWriteService} from '../../services/mws-write.service';
import {MwsApiService, type SystemSettings} from '../../api/mws-api.service';
import {TRANSLATOR} from '../../tokens';
import enCatalog from '../../../i18n/en.json';
import tabTemplate from './settings-tab.component.html?raw';
import tabStyles from './settings-tab.component.scss?raw';
import {SettingsTabComponent} from './settings-tab.component';
import {signal, ɵresolveComponentResources as resolveComponentResources} from '@angular/core';

const settings: SystemSettings = {
  backhaulEnabled: true,
  autoApShutdownEnabled: false,
  autoUpdateEnabled: true,
  autoUpdateSchedule: 'night',
  schedules: {
    night: {
      description: 'Nightly',
      action: [{action: 'start', min: '00', hour: '01', dow: '*'}, {action: 'stop', min: '00', hour: '05', dow: '*'}],
    },
    weekend: {description: 'Nightly', action: []},
  },
};

const ok = (): MwsWriteResult => ({ok: true, steps: []});

describe('SettingsTabComponent', () => {
  let api: {showSystemSettings: ReturnType<typeof vi.fn>};
  let write: {
    setBackhaul: ReturnType<typeof vi.fn>;
    setAutoApShutdown: ReturnType<typeof vi.fn>;
    setAutoUpdate: ReturnType<typeof vi.fn>;
    setAutoUpdateSchedule: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = {showSystemSettings: vi.fn(() => of(settings))};
    write = {
      setBackhaul: vi.fn(() => Promise.resolve(ok())),
      setAutoApShutdown: vi.fn(() => Promise.resolve(ok())),
      setAutoUpdate: vi.fn(() => Promise.resolve(ok())),
      setAutoUpdateSchedule: vi.fn(() => Promise.resolve(ok())),
    };
    await resolveComponentResources((url: string) => {
      if (url.endsWith('settings-tab.component.html')) {
        return Promise.resolve(tabTemplate);
      }

      if (url.endsWith('settings-tab.component.scss')) {
        return Promise.resolve(tabStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [SettingsTabComponent],
      providers: [
        {provide: MwsApiService, useValue: api},
        {provide: MwsWriteService, useValue: write},
        {provide: TRANSLATOR, useValue: createTestI18n(enCatalog)},
      ],
    }).compileComponents();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('loads toggles and preserves duplicate-description schedule IDs', async () => {
    const fixture = TestBed.createComponent(SettingsTabComponent);

    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(api.showSystemSettings).toHaveBeenCalledOnce();
    expect((fixture.nativeElement.querySelector('[data-field="backhaul"]') as HTMLInputElement).checked).toBe(true);
    expect(fixture.nativeElement.querySelectorAll('[data-field="auto-update-schedule"] option')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('[data-schedule-preview]')?.textContent).toContain('start 01:00');
  });

  it('writes toggles and Always on clears schedule', async () => {
    const fixture = TestBed.createComponent(SettingsTabComponent);

    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const backhaul = fixture.nativeElement.querySelector('[data-field="backhaul"]') as HTMLInputElement;

    backhaul.checked = false;
    backhaul.dispatchEvent(new Event('change', {bubbles: true}));

    const schedule = fixture.nativeElement.querySelector('[data-field="auto-update-schedule"]') as HTMLSelectElement;

    schedule.value = '';
    schedule.dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(write.setBackhaul).toHaveBeenCalledWith(false);
    expect(write.setAutoUpdateSchedule).toHaveBeenCalledWith(null);
    expect(fixture.nativeElement.querySelector('[data-save-success]')).not.toBeNull();
  });

  it('shows a failed save', async () => {
    write.setAutoUpdate.mockRejectedValue(new Error('rejected'));

    const fixture = TestBed.createComponent(SettingsTabComponent);

    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const checkbox = fixture.nativeElement.querySelector('[data-field="auto-update"]') as HTMLInputElement;

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', {bubbles: true}));
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-save-error]')?.textContent).toContain('rejected');
  });
});
