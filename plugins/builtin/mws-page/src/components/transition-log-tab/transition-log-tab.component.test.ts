import '@angular/compiler';
import {Subject} from 'rxjs';
import {TestBed} from '@angular/core/testing';
import {createTestI18n} from '@mndw/sdk/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TransitionLogStream} from '../../api/transition-log-api';
import {MwsApiService} from '../../api/mws-api.service';
import {TRANSLATOR} from '../../tokens';
import enCatalog from '../../../i18n/en.json';
import tabTemplate from './transition-log-tab.component.html?raw';
import tabStyles from './transition-log-tab.component.scss?raw';
import {TransitionLogTabComponent} from './transition-log-tab.component';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';

describe('TransitionLogTabComponent', () => {
  let data$: Subject<unknown>;
  let abort: ReturnType<typeof vi.fn>;
  let startTransitionLogStream: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    data$ = new Subject<unknown>();
    abort = vi.fn(() => true);
    startTransitionLogStream = vi.fn(
      () => ({process: {abort}, data$: data$.asObservable()} as unknown as TransitionLogStream),
    );
    await resolveComponentResources((url: string) => {
      if (url.endsWith('transition-log-tab.component.html')) {
        return Promise.resolve(tabTemplate);
      }

      if (url.endsWith('transition-log-tab.component.scss')) {
        return Promise.resolve(tabStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [TransitionLogTabComponent],
      providers: [
        {provide: MwsApiService, useValue: {startTransitionLogStream}},
        {provide: TRANSLATOR, useValue: createTestI18n(enCatalog)},
      ],
    }).compileComponents();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('starts only when active, merges repeated frames, and aborts on deactivation', () => {
    const fixture = TestBed.createComponent(TransitionLogTabComponent);

    fixture.detectChanges();
    expect(startTransitionLogStream).not.toHaveBeenCalled();

    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    expect(startTransitionLogStream).toHaveBeenCalledOnce();
    data$.next([{timestamp: 300, client: 'Laptop', from: 'A', to: 'B', band: null, segment: null,
      eventType: 'transition', id: '1'}]);
    data$.next([{timestamp: 300, client: 'Laptop', from: 'A', to: 'C', band: null, segment: null,
      eventType: 'transition', id: '1'}]);
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleEntries()).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('C');

    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    expect(abort).toHaveBeenCalledOnce();
  });

  it('filters current entries and downloads visible CSV', () => {
    vi.spyOn(Date, 'now').mockReturnValue(250);

    const fixture = TestBed.createComponent(TransitionLogTabComponent);

    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    data$.next([
      {timestamp: 300, client: 'Laptop', from: 'A', to: 'B', band: null, segment: null, eventType: 'transition',
        id: '1'},
      {timestamp: 100, client: 'Phone', from: null, to: 'A', band: null, segment: null, eventType: 'connected',
        id: '2'},
    ]);

    const clientInput = fixture.nativeElement.querySelector('[data-filter="client"]') as HTMLElement;

    clientInput.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: 'Laptop'}}));
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleEntries()).toHaveLength(1);

    clientInput.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: ''}}));
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleEntries()).toHaveLength(2);

    const timeSelect = fixture.nativeElement.querySelector('[data-filter="time"]') as HTMLElement;

    timeSelect.dispatchEvent(
      new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {value: 'current'}}),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleEntries()).toHaveLength(1);

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    fixture.nativeElement.querySelector<HTMLButtonElement>('[data-action="download-csv"]')?.click();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    createObjectURL.mockRestore();
    click.mockRestore();
    vi.restoreAllMocks();
  });
});
