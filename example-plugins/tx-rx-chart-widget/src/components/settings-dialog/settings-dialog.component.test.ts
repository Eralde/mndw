import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {type ComponentFixture, TestBed} from '@angular/core/testing';
import type {NetworkInterface} from '../../types/rci.types.js';
import {afterEach, describe, expect, it} from 'vitest';
import {SettingsDialogComponent} from './settings-dialog.component.js';
import settingsDialogStyles from './settings-dialog.component.scss?raw';
import settingsDialogTemplate from './settings-dialog.component.html?raw';

const interfaces: NetworkInterface[] = [
  {id: 'eth0', description: 'LAN'},
  {id: 'eth1', description: 'WAN'},
];

function queryElement<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

async function createFixture(
  selectedInterface: string,
  refresh: number,
): Promise<ComponentFixture<SettingsDialogComponent>> {
  await resolveComponentResources((url: string) => {
    if (url.endsWith('settings-dialog.component.html')) {
      return Promise.resolve(settingsDialogTemplate);
    }

    if (url.endsWith('settings-dialog.component.scss')) {
      return Promise.resolve(settingsDialogStyles);
    }

    throw new Error(`resource URL: ${url}`);
  });
  await TestBed.configureTestingModule({
    imports: [SettingsDialogComponent],
  }).compileComponents();

  const fixture = TestBed.createComponent(SettingsDialogComponent);

  fixture.componentRef.setInput('interfaces', interfaces);
  fixture.componentRef.setInput('selectedInterface', selectedInterface);
  fixture.componentRef.setInput('refresh', refresh);
  fixture.detectChanges();

  return fixture;
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('SettingsDialogComponent', () => {
  it('renders the shared select with the current interface', async () => {
    const fixture = await createFixture('eth1', 2500);

    fixture.detectChanges();

    const select = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-select');

    expect((select as unknown as {value: string}).value).toBe('eth1');
    expect(select.querySelectorAll('mndw-option')).toHaveLength(2);
  });

  it('emits the chosen interface', async () => {
    const fixture = await createFixture('eth0', 3000);
    const emitted: string[] = [];

    fixture.componentInstance.interfaceChange.subscribe((value: string) => emitted.push(value));

    const select = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-select');

    select.dispatchEvent(
      new CustomEvent('mndwchange', {detail: {value: 'eth1'}, bubbles: true, composed: true}),
    );
    fixture.detectChanges();

    expect(emitted).toEqual(['eth1']);
  });

  it('renders a range slider with the requested bounds and current value', async () => {
    const fixture = await createFixture('', 2500);

    fixture.detectChanges();

    const slider = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-slider');

    expect(slider.getAttribute('min')).toBe('1');
    expect(slider.getAttribute('max')).toBe('5');
    expect(slider.getAttribute('step')).toBe('0.5');
    expect((slider as unknown as {value: number}).value).toBe(2.5);
    expect(slider.getAttribute('value-text')).toBe('2.5 seconds');
  });

  it('emits slider values as milliseconds', async () => {
    const fixture = await createFixture('', 3000);
    let emitted = 0;

    fixture.componentInstance.refreshChange.subscribe((value: number) => emitted = value);
    fixture.detectChanges();

    const slider = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-slider');

    slider.dispatchEvent(
      new CustomEvent('mndwinput', {
        detail: {value: 4.5},
        bubbles: true,
        composed: true,
      }),
    );

    expect(emitted).toBe(4500);
  });

  it('updates displayed refresh seconds while the slider moves', async () => {
    const fixture = await createFixture('', 3000);
    const slider = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-slider');

    slider.dispatchEvent(
      new CustomEvent('mndwinput', {
        detail: {value: 4.5},
        bubbles: true,
        composed: true,
      }),
    );
    fixture.detectChanges();

    expect(slider.getAttribute('value-text')).toBe('4.5 seconds');
  });
});
