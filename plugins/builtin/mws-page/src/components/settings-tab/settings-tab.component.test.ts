import '@angular/compiler';
import {TestBed} from '@angular/core/testing';
import {createTestI18n} from '@mndw/sdk/testing';
import {of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type MwsWriteResult, MwsWriteService} from '../../services/mws-write.service';
import {MwsApiService, type SystemSettings} from '../../api/mws-api.service';
import {TRANSLATOR} from '../../tokens';
import enCatalog from '../../../i18n/en.json';
import tabTemplate from './settings-tab.component.html?raw';
import tabStyles from './settings-tab.component.scss?raw';
import {SettingsTabComponent} from './settings-tab.component';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';

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

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`missing element: ${selector}`);
  }

  return element;
}

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

    const backhaulSwitch = requiredElement<HTMLElement & {checked: boolean}>(
      fixture.nativeElement,
      'mndw-switch[data-field="backhaul"]',
    );

    expect(backhaulSwitch.checked).toBe(true);
    expect(fixture.nativeElement.querySelectorAll('[data-field="auto-update-schedule"] mndw-option')).toHaveLength(3);

    const scheduleField = requiredElement<HTMLElement & {hint: string}>(
      fixture.nativeElement,
      'mndw-field[data-field="schedule-field"]',
    );

    expect(scheduleField.hint).toContain('start 01:00');
  });

  it('writes toggles and Always on clears schedule', async () => {
    const fixture = TestBed.createComponent(SettingsTabComponent);

    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const backhaul = requiredElement<HTMLElement>(fixture.nativeElement, 'mndw-switch[data-field="backhaul"]');

    backhaul.dispatchEvent(new CustomEvent('mndwchange', {detail: {checked: false}, bubbles: true}));

    const schedule = requiredElement<HTMLElement>(
      fixture.nativeElement,
      'mndw-select[data-field="auto-update-schedule"]',
    );

    schedule.dispatchEvent(new CustomEvent('mndwchange', {detail: {value: ''}, bubbles: true}));
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

    const autoUpdate = requiredElement<HTMLElement>(fixture.nativeElement, 'mndw-switch[data-field="auto-update"]');

    autoUpdate.dispatchEvent(new CustomEvent('mndwchange', {detail: {checked: false}, bubbles: true}));
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-save-error]')?.textContent).toContain('rejected');
  });
});
