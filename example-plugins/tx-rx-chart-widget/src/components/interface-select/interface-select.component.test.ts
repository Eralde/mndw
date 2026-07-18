import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {type ComponentFixture, TestBed} from '@angular/core/testing';
import type {NetworkInterface} from '../../types/rci.types.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {InterfaceSelectComponent} from './interface-select.component.js';
import interfaceSelectStyles from './interface-select.component.scss?raw';
import interfaceSelectTemplate from './interface-select.component.html?raw';

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

async function createFixture(selectedId: string): Promise<ComponentFixture<InterfaceSelectComponent>> {
  await resolveComponentResources((url: string) => {
    if (url.endsWith('interface-select.component.html')) {
      return Promise.resolve(interfaceSelectTemplate);
    }

    if (url.endsWith('interface-select.component.scss')) {
      return Promise.resolve(interfaceSelectStyles);
    }

    throw new Error(`resource URL: ${url}`);
  });
  await TestBed.configureTestingModule({imports: [InterfaceSelectComponent]}).compileComponents();

  const fixture = TestBed.createComponent(InterfaceSelectComponent);

  fixture.componentRef.setInput('interfaces', interfaces);
  fixture.componentRef.setInput('selectedId', selectedId);
  fixture.detectChanges();

  return fixture;
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('InterfaceSelectComponent', () => {
  it('shows placeholder and no selected option when selectedId is empty', async () => {
    const fixture = await createFixture('');
    const trigger = queryElement<HTMLButtonElement>(fixture.nativeElement, '.interface-select__trigger');

    expect(trigger.textContent).toContain('Select interface…');
    trigger.click();
    fixture.detectChanges();

    const options = fixture.nativeElement.querySelectorAll('[role="option"]') as NodeListOf<HTMLElement>;

    expect(Array.from(options).every((option) => option.getAttribute('aria-selected') === 'false')).toBe(true);
  });

  it('shows the current interface and emits the clicked option', async () => {
    const fixture = await createFixture('eth1');
    let changedValue = '';

    fixture.componentInstance.selectedChange.subscribe((value: string) => changedValue = value);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.interface-select__value')?.textContent).toContain('WAN');

    queryElement<HTMLButtonElement>(fixture.nativeElement, '.interface-select__trigger').click();
    fixture.detectChanges();

    const option = queryElement<HTMLElement>(fixture.nativeElement, '[data-interface-id="eth0"]');

    option.click();

    expect(changedValue).toBe('eth0');
  });

  it('renders each option with a constrained label wrapper', async () => {
    const fixture = await createFixture('');
    const trigger = queryElement<HTMLButtonElement>(fixture.nativeElement, '.interface-select__trigger');

    trigger.click();
    fixture.detectChanges();

    const options = fixture.nativeElement.querySelectorAll('[role="option"]') as NodeListOf<HTMLElement>;

    expect(Array.from(options).every((option) => option.querySelector('.interface-select__option-label') !== null))
      .toBe(
        true,
      );
  });

  it('supports ArrowDown and Enter without selecting an option implicitly', async () => {
    const fixture = await createFixture('');
    let changedValue = '';

    fixture.componentInstance.selectedChange.subscribe((value: string) => changedValue = value);

    const trigger = queryElement<HTMLButtonElement>(fixture.nativeElement, '.interface-select__trigger');

    trigger.click();
    fixture.detectChanges();
    trigger.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
    trigger.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    fixture.detectChanges();

    expect(changedValue).toBe('eth0');
  });

  it('closes on Escape and places the panel with fixed coordinates', async () => {
    const fixture = await createFixture('');
    const trigger = queryElement<HTMLButtonElement>(fixture.nativeElement, '.interface-select__trigger');

    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 100,
      right: 300,
      bottom: 132,
      width: 200,
      height: 32,
    } as DOMRect);
    trigger.click();
    fixture.detectChanges();

    const panel = queryElement<HTMLElement>(fixture.nativeElement, '[role="listbox"]');

    expect(panel.style.position).toBe('fixed');
    expect(panel.style.left).toBe('100px');
    trigger.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    fixture.detectChanges();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
