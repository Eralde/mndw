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

  it('shows an empty label before any transition events arrive', async () => {
    const fixture = TestBed.createComponent(TransitionLogTabComponent);

    fixture.detectChanges();

    const csvButton = fixture.nativeElement.querySelector('mndw-button[data-action="download-csv"]') as HTMLElement & {
      disabled: boolean;
      updateComplete: Promise<unknown>;
      shadowRoot: ShadowRoot;
    };

    await csvButton.updateComplete;
    expect(csvButton.disabled).toBe(true);
    expect(csvButton.shadowRoot.querySelector('button')?.disabled).toBe(true);

    const table = fixture.nativeElement.querySelector('mndw-table') as HTMLElement & {
      shadowRoot: ShadowRoot;
      updateComplete: Promise<unknown>;
    };

    await Promise.resolve();
    await table.updateComplete;

    expect(table.shadowRoot.querySelector('[part="empty"]')?.textContent?.trim()).toBe('No events yet');
  });

  it('groups event filters under their legend with the CSV action in the same row', () => {
    const fixture = TestBed.createComponent(TransitionLogTabComponent);

    fixture.detectChanges();

    const fieldset = fixture.nativeElement.querySelector('fieldset.event-filters') as HTMLFieldSetElement;
    const legend = fieldset.querySelector('legend');
    const eventOptions = fieldset.querySelector('.event-options');
    const eventFilterRow = fixture.nativeElement.querySelector('.event-filter-row');
    const csvAction = fixture.nativeElement.querySelector('[data-action="download-csv"]');

    expect(legend?.textContent?.trim()).toBe('Event types');
    expect(legend?.classList.contains('mndw-field__label')).toBe(true);
    expect(eventOptions?.previousElementSibling).toBe(legend);
    expect(eventOptions?.querySelector('mndw-checkbox')).not.toBeNull();
    expect(fieldset.parentElement).toBe(eventFilterRow);
    expect(csvAction?.closest('.event-filter-row')).toBe(eventFilterRow);
  });

  it('shows a no-match label when event type filters hide every entry', async () => {
    const fixture = TestBed.createComponent(TransitionLogTabComponent);

    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    data$.next([{timestamp: 300, client: 'Laptop', from: 'A', to: 'B', band: null, segment: null,
      eventType: 'transition', id: '1'}]);
    fixture.detectChanges();

    const eventTypeFilter = fixture.nativeElement.querySelector('[data-event-type="transition"]') as HTMLElement;

    eventTypeFilter.dispatchEvent(
      new CustomEvent('mndwchange', {detail: {checked: false}, bubbles: true, composed: true}),
    );
    fixture.detectChanges();

    const table = fixture.nativeElement.querySelector('mndw-table') as HTMLElement & {
      shadowRoot: ShadowRoot;
      updateComplete: Promise<unknown>;
    };

    await Promise.resolve();
    await table.updateComplete;

    expect(table.shadowRoot.querySelector('[part="empty"]')?.textContent?.trim()).toBe(
      'No events of the selected types',
    );

    const csvButton = fixture.nativeElement.querySelector('mndw-button[data-action="download-csv"]') as HTMLElement & {
      disabled: boolean;
      updateComplete: Promise<unknown>;
      shadowRoot: ShadowRoot;
    };

    await csvButton.updateComplete;
    expect(csvButton.disabled).toBe(true);
    expect(csvButton.shadowRoot.querySelector('button')?.disabled).toBe(true);
  });

  it('filters current entries and downloads visible CSV', async () => {
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

    const csvButton = fixture.nativeElement.querySelector('mndw-button[data-action="download-csv"]') as HTMLElement & {
      disabled: boolean;
      updateComplete: Promise<unknown>;
      shadowRoot: ShadowRoot;
    };

    await csvButton.updateComplete;
    expect(csvButton.disabled).toBe(false);
    expect(csvButton.shadowRoot.querySelector('button')?.disabled).toBe(false);

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

    csvButton.click();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();

    const [csvBlob] = createObjectURL.mock.calls[0] ?? [];

    if (csvBlob === undefined) {
      throw new Error('CSV blob missing');
    }

    expect(await csvBlob.text()).toBe(
      'timestamp,client,source,target,band,segment,event type\n1970-01-01T00:00:00.300Z,Laptop,A,B,,,transition',
    );
    createObjectURL.mockRestore();
    click.mockRestore();
    vi.restoreAllMocks();
  });
});
